import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import type { AppConfig } from './config.ts';
import type { Store } from './db.ts';
import type { Supervisor } from './agents/supervisor.ts';
import { ValidationError } from './settings.ts';
import { logger } from './logger.ts';

const log = logger('http');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function hash(s: string): Buffer { return createHash('sha256').update(s).digest(); }

export function tokenMatches(expected: string | null, provided: string | null): boolean {
  if (!expected || !provided) return false;
  return timingSafeEqual(hash(expected), hash(provided));
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(data);
}

async function readJson(req: http.IncomingMessage, limit = 32_768): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new ValidationError(['corpo da requisição muito grande']);
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ValidationError(['JSON inválido']); }
}

/** Monta o estado completo exibido no painel. Cada bloco informa sua origem. */
export function buildState(sup: Supervisor, store: Store, cfg: AppConfig) {
  const today = new Date().toISOString().slice(0, 10);
  const mode = sup.settings.executionMode;
  const t = sup.market.lastTick();
  const realized = store.realizedForDay(today, mode === 'signals' ? undefined : mode);
  return {
    serverTime: new Date().toISOString(),
    engine: { status: sup.status, haltReasons: sup.haltReasons, startedAt: sup.startedAt, allowRealTrading: cfg.allowRealTrading },
    connection: {
      public: sup.pub.info(),
      account: sup.auth ? { ...sup.auth.info(), mode: sup.accountMode } : null,
      credentialsConfigured: Boolean(sup.auth),
    },
    account: sup.portfolio.account,
    market: {
      symbol: sup.market.currentSymbol,
      symbolInfo: sup.market.symbolInfo,
      lastTick: t ? { ...t, receivedAt: new Date(t.receivedAt).toISOString(), source: t.source } : null,
      ticks: sup.market.buffer.slice(-300).map((x) => [x.epoch, x.quote]),
      contracts: sup.market.contracts.filter((c) => c.contract_type === 'CALL' || c.contract_type === 'PUT').map((c) => ({ contract_type: c.contract_type, expiry_type: c.expiry_type, min: c.min_contract_duration, max: c.max_contract_duration, barriers: c.barriers })),
      contractsSource: sup.market.contractsSource,
      contractsFetchedAt: sup.market.contractsFetchedAt,
    },
    analysis: sup.lastAnalysis,
    decision: sup.lastDecision,
    recentDecisions: sup.recentDecisions.slice(0, 20),
    risk: sup.lastRisk,
    pnl: {
      day: today,
      mode,
      realized: realized.pnl,
      settled: realized.settled,
      wins: realized.wins,
      losses: realized.losses,
      unrealized: sup.portfolio.unrealized(),
      source: 'trades liquidados (proposal_open_contract is_sold=1) + contratos abertos (Deriv)',
    },
    positions: [...sup.portfolio.positions.values()],
    agents: sup.registry.list(),
    settings: sup.settings,
    trades: store.listTrades(30),
    events: store.listEvents(40),
  };
}

export function createServer(cfg: AppConfig, store: Store, sup: Supervisor): http.Server {
  const failures = new Map<string, { n: number; until: number }>();
  const streams = new Set<http.ServerResponse>();

  const broadcast = (type: string, payload: unknown) => {
    const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const r of streams) r.write(line);
  };
  let stateTimer: NodeJS.Timeout | null = null;
  const scheduleState = () => {
    if (stateTimer) return;
    stateTimer = setTimeout(() => { stateTimer = null; if (streams.size) broadcast('state', buildState(sup, store, cfg)); }, 400);
  };
  sup.on('state', scheduleState);
  sup.on('agents', scheduleState);
  sup.on('event', (e) => broadcast('audit', e));
  sup.on('tick', (t) => broadcast('tick', { symbol: t.symbol, epoch: t.epoch, quote: t.quote, pipSize: t.pipSize, receivedAt: new Date(t.receivedAt).toISOString() }));
  const keepalive = setInterval(() => { for (const r of streams) r.write(': keepalive\n\n'); }, 20_000);

  const authorized = (req: http.IncomingMessage): boolean => {
    const h = req.headers.authorization;
    const tok = h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
    return tokenMatches(cfg.adminToken, tok);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
    try {
      // ---------------- health checks (públicos, sem dados sensíveis)
      if (url.pathname === '/health') {
        return send(res, 200, { ok: true, uptimeS: Math.round(process.uptime()) });
      }
      if (url.pathname === '/health/ready') {
        const ready = sup.pub.isOpen() && sup.audit.healthy();
        return send(res, ready ? 200 : 503, { ready, publicChannel: sup.pub.status, db: sup.audit.healthy() ? 'ok' : 'erro', feedAgeMs: sup.market.feedAgeMs() });
      }

      if (url.pathname.startsWith('/api/')) {
        if (!cfg.adminToken) return send(res, 503, { error: 'ADMIN_TOKEN não configurado no servidor (mínimo 16 caracteres).' });
        const f = failures.get(ip);
        if (f && f.until > Date.now()) return send(res, 429, { error: 'muitas tentativas inválidas, aguarde' });
        if (!authorized(req)) {
          const n = (f?.n ?? 0) + 1;
          failures.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
          return send(res, 401, { error: 'não autorizado' });
        }
        failures.delete(ip);
        return await api(req, res, url);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'método não permitido' });
      return await serveStatic(res, url.pathname);
    } catch (e) {
      if (e instanceof ValidationError) return send(res, 400, { error: e.message, issues: e.issues });
      log.error('erro na requisição', e);
      return send(res, 500, { error: 'erro interno' });
    }
  });

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    const limit = Number(url.searchParams.get('limit') ?? '100') || 100;
    switch (route) {
      case 'GET /api/state': return send(res, 200, buildState(sup, store, cfg));
      case 'GET /api/stream': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
        res.write(`event: state\ndata: ${JSON.stringify(buildState(sup, store, cfg))}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      case 'POST /api/control/start':
      case 'POST /api/control/pause':
      case 'POST /api/control/stop': {
        const cmd = url.pathname.split('/').pop() as 'start' | 'pause' | 'stop';
        try { return send(res, 200, { status: sup.command(cmd) }); }
        catch (e) { return send(res, 409, { error: (e as Error).message }); }
      }
      case 'POST /api/control/ack': sup.acknowledgeHalts(); return send(res, 200, { haltReasons: sup.haltReasons });
      case 'GET /api/settings': return send(res, 200, sup.settings);
      case 'PUT /api/settings': {
        const body = (await readJson(req)) as { settings?: unknown; confirmReal?: unknown };
        try { return send(res, 200, sup.updateSettings(body.settings ?? {}, body.confirmReal === true)); }
        catch (e) { if (e instanceof ValidationError) throw e; return send(res, 409, { error: (e as Error).message }); }
      }
      case 'GET /api/trades': return send(res, 200, store.listTrades(limit));
      case 'GET /api/events': return send(res, 200, store.listEvents(limit, Number(url.searchParams.get('before')) || undefined));
      case 'GET /api/decisions': return send(res, 200, store.listDecisions(limit));
      case 'GET /api/symbols':
        return send(res, 200, { fetchedAt: sup.market.symbolsFetchedAt, source: 'deriv:active_symbols', symbols: sup.market.symbols });
      case 'GET /api/diagnostics': return send(res, 200, await sup.diagnostics());
      default: return send(res, 404, { error: 'rota não encontrada' });
    }
  }

  async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
    const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
    const file = path.resolve(cfg.frontendDir, '.' + rel);
    if (!file.startsWith(cfg.frontendDir + path.sep)) return send(res, 403, { error: 'proibido' });
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('não é arquivo');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      res.end(body);
    } catch {
      send(res, 404, { error: 'não encontrado' });
    }
  }

  server.on('close', () => { clearInterval(keepalive); for (const r of streams) r.end(); });
  return server;
}
