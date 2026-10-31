import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from './config.ts';
import type { Store } from './db.ts';
import type { Supervisor } from './agents/supervisor.ts';
import { createApi, SECURITY_HEADERS } from './api.ts';
import { logger } from './logger.ts';

export { buildState, tokenMatches } from './api.ts';

const log = logger('http');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

/** Servidor Node: adapta node:http para a API Fetch (api.ts) e entrega o painel estático. */
export function createServer(cfg: AppConfig, store: Store, sup: Supervisor): http.Server {
  const api = createApi(cfg, store, sup);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const isApi = url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/health/ready' || req.method === 'OPTIONS';
      if (isApi) {
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v); else if (Array.isArray(v)) headers.set(k, v.join(', '));
        const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
        const request = new Request(`http://localhost${req.url ?? '/'}`, {
          method: req.method, headers, signal: ac.signal,
          ...(hasBody ? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: 'half' } : {}),
        } as RequestInit);
        const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
        const response = await api.handle(request, ip);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) { res.end(); return; }
        const reader = response.body.getReader();
        res.on('close', () => { void reader.cancel().catch(() => undefined); });
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise((r) => res.once('drain', r));
        }
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'método não permitido' });
      return await serveStatic(res, url.pathname);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      log.error('erro na requisição', e);
      if (!res.headersSent) sendJson(res, 500, { error: 'erro interno' }); else res.end();
    }
  });

  function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify(body));
  }

  async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
    const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
    const file = path.resolve(cfg.frontendDir, '.' + rel);
    if (!file.startsWith(cfg.frontendDir + path.sep)) return sendJson(res, 403, { error: 'proibido' });
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('não é arquivo');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      res.end(body);
    } catch {
      sendJson(res, 404, { error: 'não encontrado' });
    }
  }

  server.on('close', () => api.close());
  return server;
}
