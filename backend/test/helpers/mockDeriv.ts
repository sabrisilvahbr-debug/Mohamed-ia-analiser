/**
 * SERVIDOR DE TESTE — reproduz o protocolo documentado da Deriv (formatos dos JSON Schemas oficiais)
 * para testar o cliente localmente. É usado SOMENTE pelos testes automatizados; o aplicativo
 * nunca o utiliza e nunca exibe dados vindos dele.
 * Implementa um WebSocket mínimo (RFC 6455, frames de texto) sobre node:http.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';

type Msg = Record<string, unknown>;

class Conn extends EventEmitter {
  private buf = Buffer.alloc(0);
  readonly path: string;
  readonly sock: Duplex;
  constructor(sock: Duplex, path: string) {
    super();
    this.sock = sock;
    this.path = path;
    sock.on('data', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('close', () => this.emit('close'));
    sock.on('error', () => this.emit('close'));
  }
  private parse(): void {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0]!, b1 = this.buf[1]!;
      const op = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const masked = (b1 & 0x80) !== 0;
      const total = off + (masked ? 4 : 0) + len;
      if (this.buf.length < total) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), total);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]!));
      }
      this.buf = this.buf.subarray(total);
      if (op === 0x1) this.emit('message', JSON.parse(payload.toString('utf8')) as Msg);
      else if (op === 0x8) { this.frame(0x8, Buffer.alloc(0)); this.sock.end(); }
      else if (op === 0x9) this.frame(0xa, payload);
    }
  }
  private frame(op: number, payload: Buffer): void {
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 0xff]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
    if (!this.sock.destroyed) this.sock.write(Buffer.concat([head, payload]));
  }
  send(m: Msg): void { this.frame(0x1, Buffer.from(JSON.stringify(m))); }
  kill(): void { this.sock.destroy(); }
}

export interface MockOptions { symbol?: string; balance?: number; currency?: string; loginid?: string }

export class MockDeriv {
  readonly server: http.Server;
  port = 0;
  conns = new Set<Conn>();
  received: Msg[] = [];
  otps = new Set<string>();
  otpRequests = 0;
  balance: number;
  /** Se definido, a próxima compra não recebe resposta (simula perda de resposta). */
  dropNextBuy = false;
  buyError: { code: string; message: string } | null = null;
  statementRows: Msg[] = [];
  private nextContract = 1000;
  private tickSubs = new Map<Conn, { reqId: unknown; sub: string }>();
  private pocSubs = new Map<number, { conn: Conn; reqId: unknown; sub: string }>();
  private balanceSubs = new Map<Conn, { reqId: unknown; sub: string }>();
  readonly symbol: string;
  readonly currency: string;
  readonly loginid: string;
  history: { prices: number[]; times: number[] } = { prices: [], times: [] };
  contracts: Msg[];

  constructor(o: MockOptions = {}) {
    this.symbol = o.symbol ?? 'R_100';
    this.balance = o.balance ?? 10000;
    this.currency = o.currency ?? 'USD';
    this.loginid = o.loginid ?? 'DOT90004580';
    this.contracts = ['CALL', 'PUT'].map((ct) => ({
      barriers: 0, contract_category: 'callput', contract_type: ct, expiry_type: 'tick', market: 'synthetic_index',
      max_contract_duration: '10t', min_contract_duration: '1t', sentiment: ct === 'CALL' ? 'up' : 'down', submarket: 'random_index', underlying_symbol: this.symbol,
    }));
    this.server = http.createServer((req, res) => this.rest(req, res));
    this.server.on('upgrade', (req, sock) => this.upgrade(req, sock));
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as { port: number }).port;
  }
  async close(): Promise<void> {
    for (const c of this.conns) c.kill();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  get rest_base(): string { return `http://127.0.0.1:${this.port}`; }
  get publicUrl(): string { return `ws://127.0.0.1:${this.port}/trading/v1/options/ws/public`; }

  private rest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const m = /^\/trading\/v1\/options\/accounts\/([A-Za-z0-9]+)\/otp$/.exec(req.url ?? '');
    const authOk = req.headers.authorization === 'Bearer test-pat-0123456789' && req.headers['deriv-app-id'] === '12345';
    if (req.method === 'POST' && m) {
      this.otpRequests++;
      if (!authOk) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ errors: [{ status: 401, code: 'Unauthorized', message: 'Invalid or missing authentication credentials' }] })); return; }
      const otp = `otp${this.otpRequests}x${Math.random().toString(36).slice(2)}`;
      this.otps.add(otp);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { url: `ws://127.0.0.1:${this.port}/trading/v1/options/ws/demo?otp=${otp}` } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/trading/v1/options/accounts') {
      res.writeHead(authOk ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(authOk ? { data: [{ account_id: this.loginid }] } : { errors: [{ code: 'Unauthorized', message: 'x' }] }));
      return;
    }
    res.writeHead(404); res.end();
  }

  private upgrade(req: http.IncomingMessage, sock: Duplex): void {
    const u = new URL(req.url ?? '/', 'http://x');
    const isPublic = u.pathname === '/trading/v1/options/ws/public';
    const isDemo = u.pathname === '/trading/v1/options/ws/demo';
    const otp = u.searchParams.get('otp');
    if (!isPublic && !(isDemo && otp && this.otps.delete(otp))) { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const key = req.headers['sec-websocket-key'] as string;
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const c = new Conn(sock, u.pathname);
    this.conns.add(c);
    c.on('close', () => { this.conns.delete(c); this.tickSubs.delete(c); this.balanceSubs.delete(c); });
    c.on('message', (m: Msg) => this.handle(c, m, isPublic));
  }

  private reply(c: Conn, m: Msg, msg_type: string, body: Msg): void {
    c.send({ echo_req: m, msg_type, ...(m.req_id !== undefined ? { req_id: m.req_id } : {}), ...body });
  }
  private err(c: Conn, m: Msg, msg_type: string, code: string, message: string): void {
    this.reply(c, m, msg_type, { error: { code, message } });
  }

  private handle(c: Conn, m: Msg, isPublic: boolean): void {
    this.received.push(m);
    if (m.ping) return this.reply(c, m, 'ping', { ping: 'pong' });
    if (m.active_symbols) return this.reply(c, m, 'active_symbols', { active_symbols: [{ exchange_is_open: 1, is_trading_suspended: 0, market: 'synthetic_index', pip_size: 0.01, subgroup: 'synthetics', submarket: 'random_index', trade_count: 0, underlying_symbol: this.symbol, underlying_symbol_name: 'Volatility 100 Index', underlying_symbol_type: 'stockindex' }] });
    if (m.ticks_history) return this.reply(c, m, 'history', { history: this.history, pip_size: 2 });
    if (m.contracts_for) return this.reply(c, m, 'contracts_for', { contracts_for: { available: this.contracts, hit_count: this.contracts.length } });
    if (m.ticks) { const sub = `tick-${Math.random()}`; this.tickSubs.set(c, { reqId: m.req_id, sub }); const last = this.history.prices.length; return this.reply(c, m, 'tick', { tick: { quote: this.history.prices[last - 1] ?? 100, epoch: this.history.times[last - 1] ?? 1, symbol: this.symbol, pip_size: 2 }, subscription: { id: sub } }); }
    if (m.forget) return this.reply(c, m, 'forget', { forget: 1 });
    if (isPublic && (m.balance || m.buy || m.proposal || m.proposal_open_contract || m.statement)) return this.err(c, m, String(Object.keys(m)[0]), 'AuthorizationRequired', 'Please log in.');
    if (m.balance) { const sub = `bal-${Math.random()}`; this.balanceSubs.set(c, { reqId: m.req_id, sub }); return this.reply(c, m, 'balance', { balance: { balance: this.balance, currency: this.currency, loginid: this.loginid, id: sub }, subscription: { id: sub } }); }
    if (m.proposal) return this.reply(c, m, 'proposal', { proposal: { id: `prop-${Math.random()}`, ask_price: m.amount, payout: Number(m.amount) * 1.95, spot: 100, spot_time: 1, date_start: 1, longcode: 'test' } });
    if (m.buy) {
      if (this.dropNextBuy) { this.dropNextBuy = false; const cid = this.nextContract++; this.balance -= Number(m.price); this.statementRows.push({ action_type: 'buy', amount: -Number(m.price), app_id: '12345', balance_after: this.balance, contract_id: cid, transaction_id: cid * 10, transaction_time: Math.floor(Date.now() / 1000), shortcode: `CALL_${this.symbol}_19.5_${Math.floor(Date.now() / 1000)}_5T_S0P_0`, longcode: 'x', payout: 1.95 }); return; }
      if (this.buyError) { const e = this.buyError; this.buyError = null; return this.err(c, m, 'buy', e.code, e.message); }
      const cid = this.nextContract++;
      this.balance -= Number(m.price);
      this.reply(c, m, 'buy', { buy: { balance_after: this.balance, buy_price: m.price, contract_id: cid, longcode: 'x', payout: Number(m.price) * 1.95, purchase_time: Math.floor(Date.now() / 1000), shortcode: 'x', start_time: Math.floor(Date.now() / 1000), transaction_id: cid * 10 } });
      this.pushBalance();
      return;
    }
    if (m.proposal_open_contract) {
      const cid = Number(m.contract_id);
      const sub = `poc-${cid}`;
      this.pocSubs.set(cid, { conn: c, reqId: m.req_id, sub });
      return this.reply(c, m, 'proposal_open_contract', { proposal_open_contract: { contract_id: cid, status: 'open', is_sold: 0, profit: '0.05', buy_price: '1.00', bid_price: '1.05', underlying_symbol: this.symbol, contract_type: 'CALL', currency: this.currency }, subscription: { id: sub } });
    }
    if (m.statement) return this.reply(c, m, 'statement', { statement: { count: this.statementRows.length, transactions: this.statementRows } });
  }

  pushTick(quote: number, epoch: number): void {
    for (const [c, s] of this.tickSubs) c.send({ echo_req: { ticks: this.symbol }, msg_type: 'tick', req_id: s.reqId, tick: { quote, epoch, symbol: this.symbol, pip_size: 2 }, subscription: { id: s.sub } });
  }
  pushBalance(): void {
    for (const [c, s] of this.balanceSubs) c.send({ echo_req: { balance: 1 }, msg_type: 'balance', req_id: s.reqId, balance: { balance: this.balance, currency: this.currency, loginid: this.loginid }, subscription: { id: s.sub } });
  }
  settle(contractId: number, won: boolean, buyPrice = 1): void {
    const s = this.pocSubs.get(contractId);
    if (!s) throw new Error(`sem assinatura poc para ${contractId}`);
    const sell = won ? Number((buyPrice * 1.95).toFixed(2)) : 0;
    if (won) this.balance += sell;
    s.conn.send({ echo_req: {}, msg_type: 'proposal_open_contract', req_id: s.reqId, subscription: { id: s.sub }, proposal_open_contract: { contract_id: contractId, status: won ? 'won' : 'lost', is_sold: 1, is_expired: 1, profit: (sell - buyPrice).toFixed(2), buy_price: buyPrice.toFixed(2), sell_price: sell.toFixed(2), entry_spot: '100.00', exit_spot: won ? '101.00' : '99.00', underlying_symbol: this.symbol, contract_type: 'CALL', currency: this.currency } });
    this.pocSubs.delete(contractId);
  }
  dropAll(): void { for (const c of this.conns) c.kill(); }
  hasPoc(cid: number): boolean { return this.pocSubs.has(cid); }
}

export async function waitFor(cond: () => boolean, timeoutMs = 4000, label = 'condição'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout aguardando ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
