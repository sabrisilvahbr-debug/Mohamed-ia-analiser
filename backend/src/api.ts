import { timingSafeEqual, createHash } from 'node:crypto';
import type { AppConfig } from './config.ts';
import type { Store } from './db.ts';
import type { Supervisor } from './agents/supervisor.ts';
import { ValidationError } from './settings.ts';
import { logger } from './logger.ts';

/**
 * API HTTP no padrão Fetch (Request → Response). É a mesma para:
 *  - o servidor Node (server.ts adapta node:http para Request/Response)
 *  - o Cloudflare Durable Object (cloudflare/src/worker.ts)
 */
const log = logger('api');

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https: wss://api.derivws.com; frame-ancestors 'none'; base-uri 'none'",
};

function hash(s: string): Buffer { return createHash('sha256').update(s).digest(); }

export function tokenMatches(expected: string | null, provided: string | null): boolean {
  if (!expected || !provided) return false;
  return timingSafeEqual(hash(expected), hash(provided));
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

export interface Api {
  handle(req: Request, clientIp?: string): Promise<Response>;
  close(): void;
}

export function createApi(cfg: AppConfig, store: Store, sup: Supervisor): Api {
  const failures = new Map<string, { n: number; until: number }>();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();

  const push = (ctrl: ReadableStreamDefaultController<Uint8Array>, text: string) => {
    try { ctrl.enqueue(enc.encode(text)); } catch { streams.delete(ctrl); }
  };
  const broadcast = (type: string, payload: unknown) => {
    const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of streams) push(c, line);
  };
  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleState = () => {
    if (stateTimer) return;
    stateTimer = setTimeout(() => { stateTimer = null; if (streams.size) broadcast('state', buildState(sup, store, cfg)); }, 400);
  };
  const onEvent = (e: unknown) => broadcast('audit', e);
  const onTick = (t: { symbol: string; epoch: number; quote: number; pipSize: number; receivedAt: number }) =>
    broadcast('tick', { symbol: t.symbol, epoch: t.epoch, quote: t.quote, pipSize: t.pipSize, receivedAt: new Date(t.receivedAt).toISOString() });
  sup.on('state', scheduleState);
  sup.on('agents', scheduleState);
  sup.on('event', onEvent);
  sup.on('tick', onTick);
  const keepalive = setInterval(() => { for (const c of streams) push(c, ': keepalive\n\n'); }, 20_000);

  const corsHeaders = (origin: string | null): Record<string, string> =>
    origin && cfg.allowedOrigins.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '600' }
      : {};

  async function handle(req: Request, clientIp = '?'): Promise<Response> {
    const url = new URL(req.url);
    const cors = corsHeaders(req.headers.get('origin'));
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...cors } });

    if (req.method === 'OPTIONS') return new Response(null, { status: Object.keys(cors).length ? 204 : 403, headers: cors });
    try {
      if (url.pathname === '/health') return json(200, { ok: true, uptimeS: Math.round((Date.now() - Date.parse(sup.startedAt)) / 1000) });
      if (url.pathname === '/health/ready') {
        const ready = sup.pub.isOpen() && sup.audit.healthy();
        return json(ready ? 200 : 503, { ready, publicChannel: sup.pub.status, db: sup.audit.healthy() ? 'ok' : 'erro', feedAgeMs: sup.market.feedAgeMs() });
      }
      if (!url.pathname.startsWith('/api/')) return json(404, { error: 'não encontrado' });

      if (!cfg.adminToken) return json(503, { error: 'ADMIN_TOKEN não configurado no servidor (mínimo 16 caracteres).' });
      const f = failures.get(clientIp);
      if (f && f.until > Date.now()) return json(429, { error: 'muitas tentativas inválidas, aguarde' });
      const h = req.headers.get('authorization');
      const tok = h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
      if (!tokenMatches(cfg.adminToken, tok)) {
        const n = (f?.n ?? 0) + 1;
        failures.set(clientIp, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
        return json(401, { error: 'não autorizado' });
      }
      failures.delete(clientIp);

      const route = `${req.method} ${url.pathname}`;
      const limit = Number(url.searchParams.get('limit') ?? '100') || 100;
      switch (route) {
        case 'GET /api/state': return json(200, buildState(sup, store, cfg));
        case 'GET /api/stream': {
          let self: ReadableStreamDefaultController<Uint8Array> | null = null;
          const body = new ReadableStream<Uint8Array>({
            start(ctrl) {
              self = ctrl;
              streams.add(ctrl);
              push(ctrl, `event: state\ndata: ${JSON.stringify(buildState(sup, store, cfg))}\n\n`);
            },
            cancel() { if (self) streams.delete(self); },
          });
          return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS, ...cors } });
        }
        case 'POST /api/control/start':
        case 'POST /api/control/pause':
        case 'POST /api/control/stop': {
          const cmd = url.pathname.split('/').pop() as 'start' | 'pause' | 'stop';
          try { return json(200, { status: sup.command(cmd) }); }
          catch (e) { return json(409, { error: (e as Error).message }); }
        }
        case 'POST /api/control/ack': sup.acknowledgeHalts(); return json(200, { haltReasons: sup.haltReasons });
        case 'GET /api/settings': return json(200, sup.settings);
        case 'PUT /api/settings': {
          const text = await req.text();
          if (text.length > 32_768) throw new ValidationError(['corpo da requisição muito grande']);
          let body: { settings?: unknown; confirmReal?: unknown } = {};
          if (text) { try { body = JSON.parse(text) as typeof body; } catch { throw new ValidationError(['JSON inválido']); } }
          try { return json(200, sup.updateSettings(body.settings ?? {}, body.confirmReal === true)); }
          catch (e) { if (e instanceof ValidationError) throw e; return json(409, { error: (e as Error).message }); }
        }
        case 'GET /api/trades': return json(200, store.listTrades(limit));
        case 'GET /api/events': return json(200, store.listEvents(limit, Number(url.searchParams.get('before')) || undefined));
        case 'GET /api/decisions': return json(200, store.listDecisions(limit));
        case 'GET /api/symbols': return json(200, { fetchedAt: sup.market.symbolsFetchedAt, source: 'deriv:active_symbols', symbols: sup.market.symbols });
        case 'GET /api/diagnostics': return json(200, await sup.diagnostics());
        default: return json(404, { error: 'rota não encontrada' });
      }
    } catch (e) {
      if (e instanceof ValidationError) return json(400, { error: e.message, issues: e.issues });
      log.error('erro na requisição', e);
      return json(500, { error: 'erro interno' });
    }
  }

  return {
    handle,
    close() {
      clearInterval(keepalive);
      sup.off('state', scheduleState); sup.off('agents', scheduleState); sup.off('event', onEvent); sup.off('tick', onTick);
      for (const c of streams) { try { c.close(); } catch { /* já fechado */ } }
      streams.clear();
    },
  };
}
