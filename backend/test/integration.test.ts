/**
 * Testes de integração contra um servidor local que fala o protocolo documentado da Deriv.
 * Nenhuma conexão com a Deriv real é feita aqui e nenhuma operação financeira é realizada.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { MockDeriv, waitFor } from './helpers/mockDeriv.ts';
import { DerivSocket, DerivApiError, DerivTimeoutError } from '../src/deriv/client.ts';
import { requestOtpUrl } from '../src/deriv/auth.ts';
import type { TickResponse } from '../src/deriv/protocol.ts';
import { readConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { Supervisor } from '../src/agents/supervisor.ts';
import { createServer } from '../src/server.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

process.env.LOG_SILENT = '1';

let mock: MockDeriv;
before(async () => { mock = new MockDeriv(); await mock.listen(); });
after(async () => { await mock.close(); });

function falling(n: number, from = 110, to = 100, epoch0 = 1000) {
  mock.history = { prices: Array.from({ length: n }, (_, i) => Number((from - ((from - to) * i) / (n - 1)).toFixed(2))), times: Array.from({ length: n }, (_, i) => epoch0 + i) };
}

function cfg(withCreds: boolean) {
  return readConfig({
    PORT: '1', ADMIN_TOKEN: 'admin-token-0123456789',
    DERIV_PUBLIC_WS: mock.publicUrl, DERIV_REST_BASE: mock.rest_base,
    ...(withCreds ? { DERIV_APP_ID: '12345', DERIV_PAT: 'test-pat-0123456789', DERIV_ACCOUNT_ID: 'DOT90004580' } : {}),
  });
}

// ------------------------------------------------------------------ cliente
test('cliente: req_id associa respostas, erros viram DerivApiError, timeout é detectado', async () => {
  const s = new DerivSocket({ name: 't', urlProvider: async () => mock.publicUrl, requestTimeoutMs: 300 });
  s.start();
  await new Promise((r) => s.once('open', r));
  const [a, b] = await Promise.all([s.send({ ping: 1 }), s.send({ active_symbols: 'brief' })]);
  assert.equal(a.msg_type, 'ping');
  assert.equal(b.msg_type, 'active_symbols');
  await assert.rejects(s.send({ balance: 1 }), (e) => e instanceof DerivApiError && e.code === 'AuthorizationRequired');
  await assert.rejects(s.send({ unknown_call: 1 }), DerivTimeoutError);
  s.stop();
});

test('cliente: reconecta com backoff após queda e reabre assinaturas', async () => {
  falling(30);
  const s = new DerivSocket({ name: 't', urlProvider: async () => mock.publicUrl, backoffMs: [50, 100] });
  let opens = 0, subscribed = 0;
  const ticks: number[] = [];
  s.on('open', async () => { opens++; await s.subscribe<TickResponse>({ ticks: 'R_100' }, (m) => { if (m.tick) ticks.push(m.tick.quote); }); subscribed++; });
  s.start();
  await waitFor(() => subscribed === 1, 3000, 'primeira assinatura confirmada');
  mock.dropAll();
  await waitFor(() => opens === 2 && subscribed === 2, 3000, 'reconexão e reassinatura confirmada');
  assert.ok(s.reconnects >= 1);
  mock.pushTick(123.45, 99999);
  await waitFor(() => ticks.includes(123.45), 2000, 'tick após reconexão');
  s.stop();
});

test('autenticação: OTP exige Bearer PAT + Deriv-App-ID e é único por conexão', async () => {
  const good = { restBase: mock.rest_base, appId: '12345', pat: 'test-pat-0123456789', accountId: 'DOT90004580' };
  const url = await requestOtpUrl(good);
  assert.match(url, /\/ws\/demo\?otp=/);
  await assert.rejects(requestOtpUrl({ ...good, pat: 'wrong' }), /401 Unauthorized/);
  await assert.rejects(requestOtpUrl({ ...good, accountId: 'bad/../id' }), /formato inválido/);
});

// ------------------------------------------------------------------ fluxo completo
async function bootSupervisor(withCreds: boolean, settings: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const store = new Store(':memory:');
  store.saveSettings({ ...structuredClone(DEFAULT_SETTINGS), executionMode: withCreds ? 'demo' : 'signals', ...settings, risk: { ...DEFAULT_SETTINGS.risk, cooldownSeconds: 0, ...(settings.risk ?? {}) } });
  const sup = new Supervisor({ config: cfg(withCreds), store, requestTimeoutMs: 1500, buyTimeoutMs: 400, backoffMs: [50, 100] });
  sup.start(100);
  await waitFor(() => sup.market.buffer.length >= 30 && sup.market.contracts.length > 0, 4000, 'feed pronto');
  if (withCreds) await waitFor(() => sup.portfolio.account !== null && sup.market.contractsSource === 'account', 4000, 'conta conectada');
  return { store, sup };
}

let epoch = 5000;
function pushRising(n: number, start = 100.5, step = 0.8) {
  for (let i = 0; i < n; i++) mock.pushTick(Number((start + i * step).toFixed(2)), ++epoch);
}

test('fluxo demo: cruzamento → proposta → compra confirmada → liquidação validada', async () => {
  falling(40);
  const { store, sup } = await bootSupervisor(true);
  assert.equal(sup.accountMode, 'demo');
  assert.equal(sup.portfolio.account?.source, 'deriv:balance');
  sup.command('start');
  pushRising(8);
  await waitFor(() => store.listTrades().some((t) => t.state === 'OPEN'), 4000, 'contrato aberto');
  const open = store.listTrades().find((t) => t.state === 'OPEN')!;
  assert.equal(open.contract_type, 'CALL');
  assert.equal(open.account_mode, 'demo');
  assert.ok(open.contract_id! >= 1000);
  assert.equal(store.listTrades().length, 1, 'apenas uma ordem para um cruzamento');
  await waitFor(() => mock.hasPoc(open.contract_id!), 3000, 'assinatura proposal_open_contract');
  assert.equal(sup.portfolio.unrealized(), 0.05);

  mock.settle(open.contract_id!, true);
  await waitFor(() => store.getTrade(open.id)!.state === 'SETTLED', 3000, 'liquidação');
  const settled = store.getTrade(open.id)!;
  assert.equal(settled.result, 'won');
  assert.equal(settled.profit, 0.95);
  const pnl = store.realizedForDay(new Date().toISOString().slice(0, 10), 'demo');
  assert.equal(pnl.pnl, 0.95);

  // PARAR: novos sinais não geram ordens
  sup.command('stop');
  for (let i = 0; i < 10; i++) mock.pushTick(Number((105 - i * 1.5).toFixed(2)), ++epoch);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(store.listTrades().length, 1);
  await sup.shutdown();
  store.close();
});

test('compra sem resposta → UNCONFIRMED bloqueia entradas → reconciliação pelo extrato', async () => {
  falling(40);
  mock.statementRows = [];
  const { store, sup } = await bootSupervisor(true);
  mock.dropNextBuy = true;
  sup.command('start');
  pushRising(8);
  await waitFor(() => store.listTrades().length === 1 && ['UNCONFIRMED', 'OPEN'].includes(store.listTrades()[0]!.state), 4000, 'ordem registrada');
  const t = store.listTrades()[0]!;
  // o watchdog (100 ms) reconcilia pelo extrato
  await waitFor(() => store.getTrade(t.id)!.state === 'OPEN', 4000, 'reconciliação');
  const rec = store.getTrade(t.id)!;
  assert.equal(rec.error, 'confirmada via extrato');
  assert.ok(rec.contract_id);
  assert.ok(store.listEvents(100).some((e) => e.type === 'buy_unconfirmed' && e.level === 'critical'));
  await sup.shutdown();
  store.close();
});

test('compra recusada pela Deriv → REJECTED, nenhum contrato contabilizado', async () => {
  falling(40);
  const { store, sup } = await bootSupervisor(true);
  mock.buyError = { code: 'InsufficientBalance', message: 'Your account balance is insufficient' };
  sup.command('start');
  pushRising(8);
  await waitFor(() => store.listTrades().some((x) => x.state === 'REJECTED'), 4000, 'rejeição');
  const r = store.listTrades()[0]!;
  assert.match(r.error!, /InsufficientBalance/);
  assert.equal(r.contract_id, null);
  await sup.shutdown();
  store.close();
});

test('sem credenciais: somente dados públicos, sem saldo e sem ordens', async () => {
  falling(40);
  const { store, sup } = await bootSupervisor(false);
  assert.equal(sup.auth, null);
  assert.equal(sup.portfolio.account, null);
  sup.command('start');
  pushRising(8);
  await waitFor(() => store.listDecisions().length > 0, 3000, 'decisão registrada');
  assert.equal(store.listDecisions()[0]!.verdict, 'signal_only');
  assert.equal(store.listTrades().length, 0);
  await sup.shutdown();
  store.close();
});

test('reinício: lock de instância e recuperação de estados interrompidos', async () => {
  const store = new Store(':memory:');
  const a = store.createTrade({ signal_key: 'x1', account_mode: 'demo', account_id: null, symbol: 'R_100', contract_type: 'CALL', duration: 5, duration_unit: 't', stake: 1, currency: 'USD' })!;
  const b = store.createTrade({ signal_key: 'x2', account_mode: 'demo', account_id: null, symbol: 'R_100', contract_type: 'CALL', duration: 5, duration_unit: 't', stake: 1, currency: 'USD' })!;
  store.updateTrade(b.id, { state: 'BUY_SENT' });
  const sup = new Supervisor({ config: cfg(false), store });
  sup.portfolio.recoverAfterRestart();
  assert.equal(store.getTrade(a.id)!.state, 'REJECTED');
  assert.equal(store.getTrade(b.id)!.state, 'UNCONFIRMED');
  sup.evaluateHalts();
  assert.ok(sup.haltReasons.some((r) => /sem confirmação/.test(r)));
  store.close();
});

// ------------------------------------------------------------------ HTTP
test('API: autenticação, validação e controles atuando no backend', async () => {
  falling(40);
  const { store, sup } = await bootSupervisor(false);
  const c = cfg(false);
  const server = createServer(c, store, sup);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const H = { Authorization: 'Bearer admin-token-0123456789', 'Content-Type': 'application/json' };

  mock.pushTick(101.11, ++epoch);
  await waitFor(() => sup.market.lastTick()?.source === 'deriv:ticks', 2000, 'tick ao vivo');
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer errado' } })).status, 401);
  const st = await (await fetch(`${base}/api/state`, { headers: H })).json() as { account: unknown; market: { lastTick: { source: string } }; connection: { credentialsConfigured: boolean } };
  assert.equal(st.account, null, 'sem credenciais não há saldo');
  assert.equal(st.connection.credentialsConfigured, false);
  assert.equal(st.market.lastTick.source, 'deriv:ticks');

  const bad = await fetch(`${base}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ settings: { stake: -1 } }) });
  assert.equal(bad.status, 400);
  const real = await fetch(`${base}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ settings: { executionMode: 'real' }, confirmReal: true }) });
  assert.equal(real.status, 409, 'modo real bloqueado sem ALLOW_REAL_TRADING');

  const r1 = await fetch(`${base}/api/control/start`, { method: 'POST', headers: H });
  assert.equal(((await r1.json()) as { status: string }).status, 'RUNNING');
  assert.equal(store.getDesired(), 'RUNNING');
  const r2 = await fetch(`${base}/api/control/stop`, { method: 'POST', headers: H });
  assert.equal(((await r2.json()) as { status: string }).status, 'STOPPED');
  assert.equal(sup.status, 'STOPPED');

  const diag = await (await fetch(`${base}/api/diagnostics`, { headers: H })).json() as { checks: { name: string; ok: boolean }[] };
  assert.ok(diag.checks.find((x) => x.name === 'Canal público Deriv')?.ok);
  assert.equal((await fetch(`${base}/../../etc/passwd`)).status, 404);

  server.close();
  await sup.shutdown();
  store.close();
});
