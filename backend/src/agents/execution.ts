import { DerivApiError, DerivDisconnectedError, DerivTimeoutError, type DerivSocket } from '../deriv/client.ts';
import type { BuyResponse, ProposalRequest, ProposalResponse } from '../deriv/protocol.ts';
import type { Store, TradeRow } from '../db.ts';
import type { Settings } from '../settings.ts';
import type { AgentRegistry } from './base.ts';
import type { AuditAgent } from './audit.ts';

export interface ExecutionRequest {
  signalKey: string;
  contractType: 'CALL' | 'PUT';
  settings: Settings;
  currency: string;
  accountMode: 'demo' | 'real';
  accountId: string | null;
}

export type ExecutionOutcome =
  | { kind: 'opened'; trade: TradeRow }
  | { kind: 'rejected'; trade: TradeRow | null; reason: string }
  | { kind: 'unconfirmed'; trade: TradeRow; reason: string }
  | { kind: 'busy' | 'duplicate'; reason: string };

/** Tolerância máxima entre stake e ask_price (proteção contra preço inesperado). */
const PRICE_TOLERANCE = 0.01;

/**
 * Agente 6 — Execution Engine.
 *  1. registra a operação no banco ANTES de qualquer envio (signal_key único → sem duplicatas)
 *  2. pede proposal (preço) e confere ask_price
 *  3. compra pelo ID da proposta (a Deriv não permite comprar a mesma proposta duas vezes)
 *  4. só marca OPEN quando a resposta de buy traz contract_id; erro → REJECTED;
 *     sem resposta/desconexão → UNCONFIRMED (o supervisor bloqueia novas entradas e reconcilia)
 * Uma única execução por vez (mutex).
 */
export class ExecutionEngine {
  private busy = false;
  private readonly store: Store;
  private readonly registry: AgentRegistry;
  private readonly audit: AuditAgent;
  private readonly buyTimeoutMs: number;

  constructor(store: Store, registry: AgentRegistry, audit: AuditAgent, buyTimeoutMs = 20_000) {
    this.buyTimeoutMs = buyTimeoutMs;
    this.store = store;
    this.registry = registry;
    this.audit = audit;
    registry.update('execution_engine', { status: 'idle', detail: 'nenhuma ordem em andamento', activity: false });
  }

  isBusy(): boolean { return this.busy; }

  async execute(sock: DerivSocket, req: ExecutionRequest): Promise<ExecutionOutcome> {
    if (this.busy) return { kind: 'busy', reason: 'outra ordem em andamento' };
    this.busy = true;
    try {
      return await this.run(sock, req);
    } finally {
      this.busy = false;
    }
  }

  private async run(sock: DerivSocket, req: ExecutionRequest): Promise<ExecutionOutcome> {
    const s = req.settings;
    const trade = this.store.createTrade({
      signal_key: req.signalKey,
      account_mode: req.accountMode,
      account_id: req.accountId,
      symbol: s.symbol,
      contract_type: req.contractType,
      duration: s.contractDuration,
      duration_unit: s.durationUnit,
      stake: s.stake,
      currency: req.currency,
    });
    if (!trade) {
      this.audit.record('warn', 'execution_engine', 'duplicate_blocked', `Ordem duplicada bloqueada (${req.signalKey})`);
      return { kind: 'duplicate', reason: 'signal_key já utilizado' };
    }
    this.registry.update('execution_engine', { status: 'ok', detail: `proposta ${req.contractType} ${s.symbol} (#${trade.id})` });

    // ---- proposal
    const proposalReq: ProposalRequest = {
      proposal: 1, amount: s.stake, basis: 'stake', contract_type: req.contractType, currency: req.currency,
      duration: s.contractDuration, duration_unit: s.durationUnit, underlying_symbol: s.symbol,
    };
    let proposal: NonNullable<ProposalResponse['proposal']>;
    try {
      const r = await sock.send<ProposalResponse>(proposalReq as unknown as Record<string, unknown>);
      if (!r.proposal || typeof r.proposal.id !== 'string' || typeof r.proposal.ask_price !== 'number') throw new Error('proposal sem id/ask_price');
      proposal = r.proposal;
    } catch (e) {
      const reason = `proposal recusada: ${(e as Error).message}`;
      const t = this.store.updateTrade(trade.id, { state: 'REJECTED', error: reason });
      this.audit.record('warn', 'execution_engine', 'proposal_rejected', `#${trade.id} ${reason}`, { req_id: e instanceof DerivApiError ? e.reqId : null });
      this.registry.update('execution_engine', { status: 'idle', detail: 'última proposta recusada', lastError: reason });
      return { kind: 'rejected', trade: t, reason };
    }
    this.store.updateTrade(trade.id, { state: 'PROPOSAL_RECEIVED', proposal_id: proposal.id, ask_price: proposal.ask_price, payout_quoted: proposal.payout });
    if (proposal.ask_price > s.stake + PRICE_TOLERANCE || proposal.ask_price > s.risk.maxStakePerTrade) {
      const reason = `ask_price ${proposal.ask_price} diferente do stake ${s.stake}`;
      const t = this.store.updateTrade(trade.id, { state: 'REJECTED', error: reason });
      this.audit.record('warn', 'execution_engine', 'price_guard', `#${trade.id} ${reason} — compra não enviada`);
      return { kind: 'rejected', trade: t, reason };
    }

    // ---- buy (por ID de proposta)
    const buyReqId = sock.peekNextReqId();
    this.store.updateTrade(trade.id, { state: 'BUY_SENT', buy_req_id: buyReqId });
    this.audit.record('info', 'execution_engine', 'buy_sent', `#${trade.id} compra enviada: ${req.contractType} ${s.symbol} stake ${s.stake} ${req.currency} (${req.accountMode})`, { req_id: buyReqId, proposal_id: proposal.id });
    try {
      const r = await sock.send<BuyResponse>({ buy: proposal.id, price: proposal.ask_price }, this.buyTimeoutMs);
      const b = r.buy;
      if (!b || !Number.isInteger(b.contract_id) || !Number.isInteger(b.transaction_id)) throw new Error('resposta de buy sem contract_id/transaction_id');
      const t = this.store.updateTrade(trade.id, {
        state: 'OPEN', contract_id: b.contract_id, transaction_id: b.transaction_id, buy_price: b.buy_price, purchase_time: b.purchase_time,
      });
      this.registry.count('execution_engine', 'ordens_confirmadas');
      this.registry.update('execution_engine', { status: 'idle', detail: `contrato ${b.contract_id} confirmado`, lastError: null });
      this.audit.record('info', 'execution_engine', 'buy_confirmed', `#${trade.id} contrato ${b.contract_id} confirmado pela Deriv (preço ${b.buy_price})`, { contract_id: b.contract_id, transaction_id: b.transaction_id, req_id: buyReqId });
      return { kind: 'opened', trade: t };
    } catch (e) {
      if (e instanceof DerivApiError) {
        // Documentação: resposta de buy com erro = nenhum contrato criado.
        const reason = `compra recusada: ${e.message}`;
        const t = this.store.updateTrade(trade.id, { state: 'REJECTED', error: reason });
        this.registry.count('execution_engine', 'ordens_recusadas');
        this.registry.update('execution_engine', { status: 'idle', detail: 'última compra recusada', lastError: reason });
        this.audit.record('warn', 'execution_engine', 'buy_rejected', `#${trade.id} ${reason}`, { req_id: buyReqId });
        return { kind: 'rejected', trade: t, reason };
      }
      const reason = e instanceof DerivTimeoutError || e instanceof DerivDisconnectedError
        ? `sem resposta da compra (${e.message}) — será reconciliada pelo extrato`
        : `erro inesperado na compra: ${(e as Error).message}`;
      const t = this.store.updateTrade(trade.id, { state: 'UNCONFIRMED', error: reason });
      this.registry.update('execution_engine', { status: 'error', detail: 'ordem sem confirmação', lastError: reason });
      this.audit.record('critical', 'execution_engine', 'buy_unconfirmed', `#${trade.id} ${reason}`, { req_id: buyReqId });
      return { kind: 'unconfirmed', trade: t, reason };
    }
  }
}
