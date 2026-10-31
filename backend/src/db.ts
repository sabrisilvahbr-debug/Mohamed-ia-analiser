import { DEFAULT_SETTINGS, validateSettings, type Settings } from './settings.ts';

export type TradeState =
  | 'PROPOSAL_REQUESTED'
  | 'PROPOSAL_RECEIVED'
  | 'BUY_SENT'
  | 'OPEN'
  | 'SETTLED'
  | 'REJECTED'
  | 'ERROR'
  | 'UNCONFIRMED';

export interface TradeRow {
  id: number;
  signal_key: string;
  created_at: string;
  updated_at: string;
  account_mode: string;
  account_id: string | null;
  symbol: string;
  contract_type: string;
  duration: number;
  duration_unit: string;
  stake: number;
  currency: string;
  state: TradeState;
  proposal_id: string | null;
  ask_price: number | null;
  payout_quoted: number | null;
  buy_req_id: number | null;
  contract_id: number | null;
  transaction_id: number | null;
  buy_price: number | null;
  purchase_time: number | null;
  result: string | null;
  sell_price: number | null;
  profit: number | null;
  entry_spot: string | null;
  exit_spot: string | null;
  settled_at: string | null;
  error: string | null;
}

export interface EventRow {
  id: number;
  ts: string;
  level: 'info' | 'warn' | 'error' | 'critical';
  agent: string;
  type: string;
  message: string;
  data: string | null;
}

export interface DecisionRow {
  id: number;
  ts: string;
  symbol: string;
  strategy: string;
  tick_epoch: number;
  action: string;
  reason: string;
  indicators: string;
  verdict: string;
  verdict_reason: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, level TEXT NOT NULL, agent TEXT NOT NULL,
  type TEXT NOT NULL, message TEXT NOT NULL, data TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, symbol TEXT NOT NULL, strategy TEXT NOT NULL,
  tick_epoch INTEGER NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, indicators TEXT NOT NULL,
  verdict TEXT NOT NULL, verdict_reason TEXT,
  UNIQUE(symbol, strategy, tick_epoch)
);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  account_mode TEXT NOT NULL, account_id TEXT,
  symbol TEXT NOT NULL, contract_type TEXT NOT NULL, duration INTEGER NOT NULL, duration_unit TEXT NOT NULL,
  stake REAL NOT NULL, currency TEXT NOT NULL, state TEXT NOT NULL,
  proposal_id TEXT, ask_price REAL, payout_quoted REAL, buy_req_id INTEGER,
  contract_id INTEGER UNIQUE, transaction_id INTEGER, buy_price REAL, purchase_time INTEGER,
  result TEXT, sell_price REAL, profit REAL, entry_spot TEXT, exit_spot TEXT, settled_at TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_state ON trades(state);
CREATE TABLE IF NOT EXISTS engine_state (id INTEGER PRIMARY KEY CHECK (id = 1), desired TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS instance_lock (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, heartbeat_ms INTEGER NOT NULL);
`;

export type DesiredState = 'RUNNING' | 'PAUSED' | 'STOPPED';

/**
 * Driver SQL mínimo. Implementações:
 *  - db-node.ts: node:sqlite (servidor Node, VM, Render, Docker)
 *  - cloudflare/src/sql-driver.ts: SQLite do Durable Object (Cloudflare)
 */
export type SqlValue = string | number | null;
export interface SqlStatement {
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  /** changes = linhas afetadas (> 0 quando algo foi escrito) */
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
}
export interface SqlDriver {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close?(): void;
}

export class Store {
  readonly db: SqlDriver;
  readonly instanceId = globalThis.crypto.randomUUID();

  constructor(driver: SqlDriver) {
    this.db = driver;
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close?.(); }

  // ---------------- lock de instância única ----------------
  /**
   * Garante que apenas UMA instância do motor opere sobre este banco.
   * Retorna true se adquiriu (ou renovou) o lock.
   */
  acquireLock(staleMs = 30_000, now = Date.now()): boolean {
    const row = this.db.prepare('SELECT owner, heartbeat_ms FROM instance_lock WHERE id = 1').get() as
      | { owner: string; heartbeat_ms: number }
      | undefined;
    if (!row) {
      this.db.prepare('INSERT INTO instance_lock (id, owner, heartbeat_ms) VALUES (1, ?, ?)').run(this.instanceId, now);
      return true;
    }
    if (row.owner === this.instanceId || now - row.heartbeat_ms > staleMs) {
      const r = this.db
        .prepare('UPDATE instance_lock SET owner = ?, heartbeat_ms = ? WHERE id = 1 AND owner = ? AND heartbeat_ms = ?')
        .run(this.instanceId, now, row.owner, row.heartbeat_ms);
      return r.changes > 0;
    }
    return false;
  }

  releaseLock(): void {
    this.db.prepare('DELETE FROM instance_lock WHERE id = 1 AND owner = ?').run(this.instanceId);
  }

  // ---------------- configurações ----------------
  getSettings(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'main'").get() as { value: string } | undefined;
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(row.value) as Partial<Settings>;
    const merged: Settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...parsed,
      ema: { ...DEFAULT_SETTINGS.ema, ...parsed.ema },
      rsi: { ...DEFAULT_SETTINGS.rsi, ...parsed.rsi },
      risk: { ...DEFAULT_SETTINGS.risk, ...parsed.risk },
    };
    return validateSettings(merged);
  }

  saveSettings(s: Settings): void {
    validateSettings(s);
    this.db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('main', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(JSON.stringify(s), new Date().toISOString());
  }

  // ---------------- estado desejado do motor ----------------
  getDesired(): DesiredState {
    const row = this.db.prepare('SELECT desired FROM engine_state WHERE id = 1').get() as { desired: DesiredState } | undefined;
    return row?.desired ?? 'STOPPED';
  }

  setDesired(d: DesiredState): void {
    this.db
      .prepare('INSERT INTO engine_state (id, desired, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET desired = excluded.desired, updated_at = excluded.updated_at')
      .run(d, new Date().toISOString());
  }

  // ---------------- eventos ----------------
  addEvent(e: Omit<EventRow, 'id' | 'ts' | 'data'> & { data?: unknown }): EventRow {
    const ts = new Date().toISOString();
    const data = e.data === undefined ? null : JSON.stringify(e.data);
    const r = this.db
      .prepare('INSERT INTO events (ts, level, agent, type, message, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts, e.level, e.agent, e.type, e.message, data);
    return { id: Number(r.lastInsertRowid), ts, level: e.level, agent: e.agent, type: e.type, message: e.message, data };
  }

  listEvents(limit = 100, beforeId?: number): EventRow[] {
    const lim = Math.min(Math.max(1, limit), 500);
    if (beforeId) return this.db.prepare('SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, lim) as unknown as EventRow[];
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(lim) as unknown as EventRow[];
  }

  // ---------------- decisões ----------------
  /** Insere a decisão. Retorna null se a mesma (symbol, strategy, tick_epoch) já existe — evita duplicidade. */
  addDecision(d: Omit<DecisionRow, 'id' | 'ts'>): DecisionRow | null {
    const ts = new Date().toISOString();
    const r = this.db
      .prepare('INSERT OR IGNORE INTO decisions (ts, symbol, strategy, tick_epoch, action, reason, indicators, verdict, verdict_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ts, d.symbol, d.strategy, d.tick_epoch, d.action, d.reason, d.indicators, d.verdict, d.verdict_reason);
    if (r.changes === 0) return null;
    return { id: Number(r.lastInsertRowid), ts, ...d };
  }

  updateDecisionVerdict(id: number, verdict: string, reason: string | null): void {
    this.db.prepare('UPDATE decisions SET verdict = ?, verdict_reason = ? WHERE id = ?').run(verdict, reason, id);
  }

  listDecisions(limit = 100): DecisionRow[] {
    return this.db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(1, limit), 500)) as unknown as DecisionRow[];
  }

  // ---------------- operações ----------------
  /** Cria a operação. Retorna null se signal_key já existe (ordem duplicada bloqueada pelo banco). */
  createTrade(t: Pick<TradeRow, 'signal_key' | 'account_mode' | 'account_id' | 'symbol' | 'contract_type' | 'duration' | 'duration_unit' | 'stake' | 'currency'>): TradeRow | null {
    const now = new Date().toISOString();
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO trades (signal_key, created_at, updated_at, account_mode, account_id, symbol, contract_type, duration, duration_unit, stake, currency, state)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSAL_REQUESTED')`)
      .run(t.signal_key, now, now, t.account_mode, t.account_id, t.symbol, t.contract_type, t.duration, t.duration_unit, t.stake, t.currency);
    if (r.changes === 0) return null;
    return this.getTrade(Number(r.lastInsertRowid));
  }

  getTrade(id: number): TradeRow | null {
    return (this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as unknown as TradeRow | undefined) ?? null;
  }

  getTradeByContract(contractId: number): TradeRow | null {
    return (this.db.prepare('SELECT * FROM trades WHERE contract_id = ?').get(contractId) as unknown as TradeRow | undefined) ?? null;
  }

  updateTrade(id: number, patch: Partial<Omit<TradeRow, 'id' | 'signal_key' | 'created_at'>>): TradeRow {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length) {
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      const values = keys.map((k) => (patch[k] ?? null) as string | number | null);
      this.db.prepare(`UPDATE trades SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, new Date().toISOString(), id);
    }
    const t = this.getTrade(id);
    if (!t) throw new Error(`trade ${id} não encontrado`);
    return t;
  }

  listTrades(limit = 100): TradeRow[] {
    return this.db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(1, limit), 500)) as unknown as TradeRow[];
  }

  /** Operações que ainda podem gerar exposição (abertas ou sem confirmação). */
  listActiveTrades(): TradeRow[] {
    return this.db
      .prepare("SELECT * FROM trades WHERE state IN ('PROPOSAL_REQUESTED','PROPOSAL_RECEIVED','BUY_SENT','OPEN','UNCONFIRMED') ORDER BY id")
      .all() as unknown as TradeRow[];
  }

  /** Resultado realizado (somente contratos liquidados e validados) no dia UTC indicado. */
  realizedForDay(dayIso: string, mode?: string): { pnl: number; settled: number; wins: number; losses: number } {
    const params: (string | number)[] = [dayIso + '%'];
    let sql = "SELECT COALESCE(SUM(profit),0) AS pnl, COUNT(*) AS n, SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) AS w, SUM(CASE WHEN profit <= 0 THEN 1 ELSE 0 END) AS l FROM trades WHERE state = 'SETTLED' AND settled_at LIKE ?";
    if (mode) { sql += ' AND account_mode = ?'; params.push(mode); }
    const row = this.db.prepare(sql).get(...params) as { pnl: number; n: number; w: number | null; l: number | null };
    return { pnl: row.pnl, settled: row.n, wins: row.w ?? 0, losses: row.l ?? 0 };
  }

  /** Quantidade de perdas consecutivas mais recentes (contratos liquidados). */
  consecutiveLosses(mode?: string): number {
    const rows = (mode
      ? this.db.prepare("SELECT profit FROM trades WHERE state = 'SETTLED' AND account_mode = ? ORDER BY settled_at DESC, id DESC LIMIT 100").all(mode)
      : this.db.prepare("SELECT profit FROM trades WHERE state = 'SETTLED' ORDER BY settled_at DESC, id DESC LIMIT 100").all()) as { profit: number }[];
    let n = 0;
    for (const r of rows) { if (r.profit < 0) n++; else break; }
    return n;
  }

  lastEntryTime(): number | null {
    const row = this.db.prepare("SELECT created_at FROM trades WHERE state NOT IN ('REJECTED') ORDER BY id DESC LIMIT 1").get() as { created_at: string } | undefined;
    return row ? Date.parse(row.created_at) : null;
  }
}
