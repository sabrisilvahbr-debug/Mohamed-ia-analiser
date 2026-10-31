import { EventEmitter } from 'node:events';
import type { DerivSocket } from '../deriv/client.ts';
import { toNum, type BalanceResponse, type OpenContract, type ProposalOpenContractResponse, type StatementResponse, type StatementTransaction } from '../deriv/protocol.ts';
import type { Store, TradeRow } from '../db.ts';
import type { AgentRegistry } from './base.ts';
import type { AuditAgent } from './audit.ts';

export interface AccountSnapshot {
  loginid: string;
  balance: number;
  currency: string;
  mode: 'demo' | 'real' | 'desconhecido';
  receivedAt: string;
  source: 'deriv:balance';
}

export interface OpenPosition {
  tradeId: number;
  contractId: number;
  profit: number | null;
  bidPrice: number | null;
  status: string | null;
  updatedAt: string;
}

export type SettlementCheck =
  | { kind: 'open'; profit: number | null; bid: number | null }
  | { kind: 'settled'; result: string; sellPrice: number; profit: number; buyPrice: number; entry: string | null; exit: string | null }
  | { kind: 'inconsistent'; reason: string };

/** Valida o resultado de um contrato antes de considerá-lo liquidado. Função pura. */
export function checkSettlement(poc: OpenContract): SettlementCheck {
  if (poc.is_sold !== 1) return { kind: 'open', profit: toNum(poc.profit), bid: toNum(poc.bid_price) };
  const sell = toNum(poc.sell_price), buy = toNum(poc.buy_price), profit = toNum(poc.profit);
  if (sell === null || buy === null || profit === null) return { kind: 'inconsistent', reason: 'contrato vendido sem sell_price/buy_price/profit numéricos' };
  if (poc.status !== 'won' && poc.status !== 'lost' && poc.status !== 'sold') return { kind: 'inconsistent', reason: `status inesperado para contrato vendido: ${String(poc.status)}` };
  if (Math.abs(sell - buy - profit) > 0.011) return { kind: 'inconsistent', reason: `profit ${profit} ≠ sell_price ${sell} − buy_price ${buy}` };
  return {
    kind: 'settled', result: poc.status, sellPrice: sell, profit, buyPrice: buy,
    entry: poc.entry_spot == null ? null : String(poc.entry_spot), exit: poc.exit_spot == null ? null : String(poc.exit_spot),
  };
}

/** Procura no extrato a compra correspondente a uma ordem sem confirmação. Função pura. */
export function matchStatement(trade: TradeRow, txs: readonly StatementTransaction[], appId: string | null, knownContractIds: ReadonlySet<number>): StatementTransaction[] {
  const created = Math.floor(Date.parse(trade.created_at) / 1000);
  const price = trade.ask_price ?? trade.stake;
  return txs.filter((t) =>
    t.action_type === 'buy' &&
    t.contract_id !== null && !knownContractIds.has(t.contract_id) &&
    Math.abs(Math.abs(t.amount) - price) <= 0.011 &&
    t.transaction_time >= created - 10 && t.transaction_time <= created + 120 &&
    (t.app_id === null || appId === null || String(t.app_id) === String(appId)) &&
    (!t.shortcode || t.shortcode.startsWith(`${trade.contract_type}_${trade.symbol}_`)),
  );
}

/**
 * Agente 7 — Portfolio Monitor (canal autenticado):
 * saldo (balance com subscribe), contratos abertos (proposal_open_contract por contract_id),
 * liquidação somente após is_sold=1 com valores consistentes, e reconciliação pelo extrato.
 */
export class PortfolioMonitor extends EventEmitter {
  account: AccountSnapshot | null = null;
  positions = new Map<number, OpenPosition>();
  private pocSubs = new Map<number, string | null>();
  private readonly store: Store;
  private readonly registry: AgentRegistry;
  private readonly audit: AuditAgent;
  private readonly appId: string | null;
  private sock: DerivSocket | null = null;
  private mode: AccountSnapshot['mode'] = 'desconhecido';

  constructor(store: Store, registry: AgentRegistry, audit: AuditAgent, appId: string | null) {
    super();
    this.store = store;
    this.registry = registry;
    this.audit = audit;
    this.appId = appId;
    registry.update('portfolio_monitor', { status: 'idle', detail: 'sem conta Deriv conectada', activity: false });
  }

  /** Recupera operações interrompidas por reinício do servidor. */
  recoverAfterRestart(): void {
    for (const t of this.store.listActiveTrades()) {
      if (t.state === 'PROPOSAL_REQUESTED' || t.state === 'PROPOSAL_RECEIVED') {
        this.store.updateTrade(t.id, { state: 'REJECTED', error: 'servidor reiniciado antes do envio da compra' });
        this.audit.record('warn', 'portfolio_monitor', 'recovered', `#${t.id} encerrada: reinício antes da compra (nenhuma ordem enviada)`);
      } else if (t.state === 'BUY_SENT') {
        this.store.updateTrade(t.id, { state: 'UNCONFIRMED', error: 'servidor reiniciado após envio da compra' });
        this.audit.record('critical', 'portfolio_monitor', 'recovered', `#${t.id} compra enviada sem confirmação antes do reinício — reconciliação necessária`);
      }
    }
  }

  attach(sock: DerivSocket, mode: () => AccountSnapshot['mode']): void {
    this.sock = sock;
    sock.on('open', () => {
      this.mode = mode();
      this.onOpen(sock).catch((e: Error) => this.audit.record('error', 'portfolio_monitor', 'open_error', e.message));
    });
    sock.on('down', (reason: string) => {
      this.pocSubs.clear();
      this.registry.update('portfolio_monitor', { status: 'degraded', detail: 'canal da conta desconectado — reconectando', lastError: reason });
    });
  }

  private async onOpen(sock: DerivSocket): Promise<void> {
    try {
      const sub = await sock.subscribe<BalanceResponse>({ balance: 1 }, (m) => this.onBalance(m));
      this.onBalance(sub.first);
    } catch (e) {
      this.registry.update('portfolio_monitor', { status: 'error', detail: 'falha ao consultar saldo', lastError: (e as Error).message });
      this.audit.record('error', 'portfolio_monitor', 'balance_failed', `Consulta de saldo falhou: ${(e as Error).message}`);
    }
    await this.syncOpenContracts();
    await this.reconcile();
  }

  private onBalance(m: BalanceResponse): void {
    const b = m.balance;
    if (!b || typeof b.balance !== 'number' || !Number.isFinite(b.balance)) return;
    const first = this.account === null;
    this.account = { loginid: b.loginid, balance: b.balance, currency: b.currency, mode: this.mode, receivedAt: new Date().toISOString(), source: 'deriv:balance' };
    this.registry.update('portfolio_monitor', { status: 'ok', detail: `saldo ${b.balance.toFixed(2)} ${b.currency} (${this.mode})`, lastError: null });
    if (first) this.audit.record('info', 'portfolio_monitor', 'account_connected', `Conta ${b.loginid} conectada (${this.mode}) — saldo informado pela Deriv: ${b.balance.toFixed(2)} ${b.currency}`);
    this.emit('balance', this.account);
  }

  /** Assina proposal_open_contract para cada contrato OPEN ainda não acompanhado. */
  async syncOpenContracts(): Promise<void> {
    const sock = this.sock;
    if (!sock?.isOpen()) return;
    for (const t of this.store.listActiveTrades()) {
      if (t.state !== 'OPEN' || t.contract_id === null || this.pocSubs.has(t.contract_id)) continue;
      await this.watch(sock, t);
    }
  }

  private async watch(sock: DerivSocket, t: TradeRow): Promise<void> {
    const cid = t.contract_id!;
    this.pocSubs.set(cid, null);
    try {
      const sub = await sock.subscribe<ProposalOpenContractResponse>({ proposal_open_contract: 1, contract_id: cid }, (m) => this.onPoc(m));
      this.pocSubs.set(cid, sub.subscriptionId);
      this.onPoc(sub.first);
    } catch (e) {
      this.pocSubs.delete(cid);
      this.audit.record('error', 'portfolio_monitor', 'poc_failed', `Acompanhamento do contrato ${cid} falhou: ${(e as Error).message}`);
    }
  }

  private onPoc(m: ProposalOpenContractResponse): void {
    const poc = m.proposal_open_contract;
    if (!poc || !Number.isInteger(poc.contract_id)) return;
    const trade = this.store.getTradeByContract(poc.contract_id);
    if (!trade || trade.state !== 'OPEN') return;
    const check = checkSettlement(poc);
    if (check.kind === 'open') {
      this.positions.set(trade.id, { tradeId: trade.id, contractId: poc.contract_id, profit: check.profit, bidPrice: check.bid, status: poc.status, updatedAt: new Date().toISOString() });
      this.registry.update('portfolio_monitor', { status: 'ok', detail: `${this.positions.size} contrato(s) em aberto` });
      this.emit('position');
      return;
    }
    if (check.kind === 'inconsistent') {
      this.audit.record('critical', 'portfolio_monitor', 'settlement_inconsistent', `Contrato ${poc.contract_id}: ${check.reason}. Resultado NÃO contabilizado.`);
      this.store.updateTrade(trade.id, { error: check.reason });
      this.emit('critical', check.reason);
      return;
    }
    const updated = this.store.updateTrade(trade.id, {
      state: 'SETTLED', result: check.result, sell_price: check.sellPrice, profit: check.profit, buy_price: check.buyPrice,
      entry_spot: check.entry, exit_spot: check.exit, settled_at: new Date().toISOString(),
    });
    this.positions.delete(trade.id);
    const subId = this.pocSubs.get(poc.contract_id);
    this.pocSubs.delete(poc.contract_id);
    if (subId && this.sock) void this.sock.forget(subId);
    this.registry.count('portfolio_monitor', 'liquidados');
    this.registry.update('portfolio_monitor', { status: 'ok', detail: `contrato ${poc.contract_id} liquidado: ${check.result}` });
    this.audit.record('info', 'portfolio_monitor', 'settled', `Contrato ${poc.contract_id} liquidado pela Deriv: ${check.result}, resultado ${check.profit.toFixed(2)} ${trade.currency}`, { contract_id: poc.contract_id, profit: check.profit });
    this.emit('settled', updated);
  }

  /** Reconciliação de ordens sem confirmação usando o extrato (Best practices da Deriv). */
  async reconcile(now = Date.now()): Promise<void> {
    const sock = this.sock;
    if (!sock?.isOpen()) return;
    const pending = this.store.listActiveTrades().filter((t) => t.state === 'UNCONFIRMED');
    if (!pending.length) return;
    const earliest = Math.min(...pending.map((t) => Math.floor(Date.parse(t.created_at) / 1000)));
    let txs: StatementTransaction[];
    try {
      const r = await sock.send<StatementResponse>({ statement: 1, action_type: 'buy', date_from: earliest - 10, description: 1, limit: 100 });
      txs = r.statement?.transactions ?? [];
    } catch (e) {
      this.audit.record('error', 'portfolio_monitor', 'statement_failed', `Extrato indisponível para reconciliação: ${(e as Error).message}`);
      return;
    }
    const known = new Set(this.store.listTrades(500).map((t) => t.contract_id).filter((c): c is number => c !== null));
    for (const t of pending) {
      const matches = matchStatement(t, txs, this.appId, known);
      if (matches.length === 1) {
        const m = matches[0]!;
        const upd = this.store.updateTrade(t.id, { state: 'OPEN', contract_id: m.contract_id, transaction_id: m.transaction_id, buy_price: Math.abs(m.amount), error: 'confirmada via extrato' });
        known.add(m.contract_id!);
        this.audit.record('warn', 'portfolio_monitor', 'reconciled', `#${t.id} encontrada no extrato: contrato ${m.contract_id}`);
        await this.watch(sock, upd);
      } else if (matches.length === 0 && now - Date.parse(t.created_at) > 150_000) {
        this.store.updateTrade(t.id, { state: 'REJECTED', error: 'compra não encontrada no extrato da conta' });
        this.audit.record('warn', 'portfolio_monitor', 'reconciled', `#${t.id} não consta no extrato — nenhum contrato foi criado`);
      } else if (matches.length > 1) {
        this.audit.record('critical', 'portfolio_monitor', 'reconcile_ambiguous', `#${t.id}: ${matches.length} compras compatíveis no extrato — revisão manual necessária`);
      }
    }
  }

  unrealized(): number | null {
    if (!this.positions.size) return null;
    let s = 0;
    for (const p of this.positions.values()) { if (p.profit === null) return null; s += p.profit; }
    return s;
  }
}
