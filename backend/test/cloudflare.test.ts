/**
 * Executa o código REAL do Worker/Durable Object (cloudflare/src) no Node:
 *  - 'cloudflare:workers' é substituído por um stub mínimo da classe DurableObject
 *  - ctx.storage.sql imita a API SqlStorage do Durable Object sobre node:sqlite
 *  - a Deriv é o servidor de protocolo local dos testes
 * Não substitui um deploy real, mas valida roteamento, SQL, alarmes e o fluxo de ordens.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { MockDeriv, waitFor } from './helpers/mockDeriv.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

process.env.LOG_SILENT = '1';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') {
      const src = 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
      return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

/** Imitação da API SqlStorage do Durable Object sobre node:sqlite. */
function fakeSqlStorage() {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    exec(query: string, ...bindings: (string | number | null)[]) {
      let rows: Record<string, unknown>[] = [];
      let written = 0;
      const statements = query.split(';').map((q) => q.trim()).filter(Boolean);
      if (statements.length > 1) { if (bindings.length) throw new Error('bindings em múltiplas instruções'); db.exec(query); }
      else {
        const st = db.prepare(statements[0]!);
        if (/^\s*(select|with|pragma)/i.test(statements[0]!) || /returning/i.test(statements[0]!)) rows = st.all(...bindings) as Record<string, unknown>[];
        else written = Number(st.run(...bindings).changes);
      }
      return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('not one'); return rows[0]!; }, rowsWritten: written, rowsRead: rows.length, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
}

function fakeCtx() {
  const sql = fakeSqlStorage();
  let alarm: number | null = null;
  return {
    sql,
    get alarm() { return alarm; },
    ctx: {
      storage: { sql, getAlarm: async () => alarm, setAlarm: async (t: number) => { alarm = t; } },
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    },
  };
}

let mock: MockDeriv;
before(async () => { mock = new MockDeriv(); await mock.listen(); });
after(async () => { await mock.close(); });

test('Cloudflare: Durable Object roda o motor completo (dados, saldo, ordem demo, liquidação)', async () => {
  mock.history = { prices: Array.from({ length: 40 }, (_, i) => Number((110 - i * 0.25).toFixed(2))), times: Array.from({ length: 40 }, (_, i) => 1000 + i) };
  const mod = await import('../../cloudflare/src/worker.ts');
  const f = fakeCtx();
  const env: Record<string, unknown> = {
    ADMIN_TOKEN: 'admin-token-0123456789', DERIV_APP_ID: '12345', DERIV_PAT: 'test-pat-0123456789', // sem DERIV_ACCOUNT_ID: conta demo descoberta via GET /accounts
    DERIV_PUBLIC_WS: mock.publicUrl, DERIV_REST_BASE: mock.rest_base, ALLOW_REAL_TRADING: 'false',
  };
  const engine = new mod.TraderEngine(f.ctx as never, env as never);
  // Worker de entrada: /api → Durable Object; resto → assets
  let assetsHit = 0;
  env.ASSETS = { fetch: async () => { assetsHit++; return new Response('<html>'); } };
  env.TRADER = { idFromName: () => 'main', get: () => ({ fetch: (r: Request | string) => engine.fetch(typeof r === 'string' ? new Request(r) : r) }) };

  const H = { Authorization: 'Bearer admin-token-0123456789', 'Content-Type': 'application/json' };
  const call = (path: string, init: RequestInit = {}) => mod.default.fetch(new Request('https://x.workers.dev' + path, init), env as never);

  assert.equal((await call('/')).status, 200);
  assert.equal(assetsHit, 1);
  assert.equal((await call('/health')).status, 200);
  assert.ok(f.alarm && f.alarm > Date.now(), 'alarme de keep-alive agendado');
  assert.equal((await call('/api/state')).status, 401);

  // estado: tabelas criadas no SQLite do DO, conta demo conectada via OTP
  await waitFor(() => (f.sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='trades'").toArray()[0] as { n: number }).n === 1, 2000, 'schema');
  await new Promise((r) => setTimeout(r, 1200));
  const st = await (await call('/api/state', { headers: H })).json() as { connection: { public: { status: string } }; account: { source: string; mode: string } };
  assert.equal(st.connection.public.status, 'open');
  assert.equal(st.account.source, 'deriv:balance');
  assert.equal(st.account.mode, 'demo');

  // configura modo demo e inicia pela API
  const put = await call('/api/settings', { method: 'PUT', headers: H, body: JSON.stringify({ settings: { executionMode: 'demo', risk: { ...DEFAULT_SETTINGS.risk, cooldownSeconds: 0 } } }) });
  assert.equal(put.status, 200);
  assert.equal(((await (await call('/api/control/start', { method: 'POST', headers: H })).json()) as { status: string }).status, 'RUNNING');

  let e = 5000;
  for (let i = 0; i < 8; i++) mock.pushTick(Number((100.5 + i * 0.8).toFixed(2)), ++e);
  await new Promise((r) => setTimeout(r, 1500));
  const trades = await (await call('/api/trades', { headers: H })).json() as { state: string; account_mode: string; contract_id: number }[];
  assert.equal(trades.length, 1, 'uma ordem para um cruzamento');
  assert.equal(trades[0]!.state, 'OPEN');
  assert.equal(trades[0]!.account_mode, 'demo');
  const cid = trades[0]!.contract_id;
  await waitFor(() => mock.hasPoc(cid), 3000, 'proposal_open_contract');
  mock.settle(cid, false);
  await waitFor(() => (f.sql.exec('SELECT state FROM trades WHERE contract_id = ?', cid).toArray()[0] as { state: string }).state === 'SETTLED', 3000, 'liquidação');
  const row = f.sql.exec('SELECT result, profit FROM trades WHERE contract_id = ?', cid).toArray()[0] as { result: string; profit: number };
  assert.equal(row.result, 'lost');
  assert.equal(row.profit, -1);

  // alarme reprograma; cron acorda o motor
  await engine.alarm();
  assert.ok(f.alarm! > Date.now());
  const waits: Promise<unknown>[] = [];
  await mod.default.scheduled({}, env as never, { waitUntil: (p: Promise<unknown>) => { waits.push(p); } });
  await Promise.all(waits);

  // stream SSE entrega dados pelo Durable Object
  const ac = new AbortController();
  const sres = await call('/api/stream', { headers: H, signal: ac.signal });
  const reader = sres.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /^event: state/);
  ac.abort(); await reader.cancel().catch(() => undefined);

  // desliga sockets para encerrar o teste
  const internals = engine as unknown as { sup: { shutdown(): Promise<void> }; api: { close(): void } };
  internals.api.close();
  await internals.sup.shutdown();
});
