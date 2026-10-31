import { EventEmitter } from 'node:events';
import type { DerivSocket } from '../deriv/client.ts';
import type { ActiveSymbol, ActiveSymbolsResponse, ContractAvailable, ContractsForResponse, TickResponse, TicksHistoryResponse } from '../deriv/protocol.ts';
import type { AgentRegistry } from './base.ts';
import type { AuditAgent } from './audit.ts';

export interface NormalizedTick {
  symbol: string;
  epoch: number;
  quote: number;
  pipSize: number;
  /** horário local de recebimento (ms) — usado para medir atraso */
  receivedAt: number;
  source: 'deriv:ticks' | 'deriv:ticks_history';
}

const BUFFER = 1000;

/** Normaliza e valida uma cotação recebida. Retorna null se inválida. */
export function normalizeTick(raw: unknown, expectedSymbol: string, receivedAt: number, source: NormalizedTick['source']): NormalizedTick | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const quote = t.quote, epoch = t.epoch, symbol = t.symbol, pip = t.pip_size;
  if (typeof quote !== 'number' || !Number.isFinite(quote) || quote <= 0) return null;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch <= 0) return null;
  if (symbol !== expectedSymbol) return null;
  return { symbol, epoch, quote, pipSize: typeof pip === 'number' && pip >= 0 ? pip : 0, receivedAt, source };
}

/**
 * Agente 1 — Market Data. Usa o canal PÚBLICO da Deriv (sem autenticação):
 * active_symbols → valida o símbolo, ticks_history → aquecimento, ticks → fluxo contínuo,
 * contracts_for → contratos efetivamente oferecidos.
 */
export class MarketDataAgent extends EventEmitter {
  symbols: ActiveSymbol[] = [];
  symbolsFetchedAt: string | null = null;
  symbolInfo: ActiveSymbol | null = null;
  contracts: ContractAvailable[] = [];
  contractsSource: 'public' | 'account' | null = null;
  contractsFetchedAt: string | null = null;
  /** Canal autenticado (quando existe): contracts_for pela visão da conta tem prioridade. */
  accountSocket: DerivSocket | null = null;
  private contractsSymbol: string | null = null;
  buffer: NormalizedTick[] = [];
  private symbol: string;
  private subscriptionId: string | null = null;
  private generation = 0;
  private readonly pub: DerivSocket;
  private readonly registry: AgentRegistry;
  private readonly audit: AuditAgent;

  constructor(pub: DerivSocket, registry: AgentRegistry, audit: AuditAgent, symbol: string) {
    super();
    this.pub = pub;
    this.registry = registry;
    this.audit = audit;
    this.symbol = symbol;
    pub.on('open', () => { void this.bootstrap(); });
    pub.on('down', (reason: string) => {
      this.subscriptionId = null;
      this.registry.update('market_data', { status: 'degraded', detail: 'canal público desconectado — reconectando', lastError: reason });
    });
  }

  get currentSymbol(): string { return this.symbol; }
  lastTick(): NormalizedTick | null { return this.buffer.at(-1) ?? null; }
  feedAgeMs(now = Date.now()): number | null { const t = this.lastTick(); return t ? now - t.receivedAt : null; }

  async setSymbol(symbol: string): Promise<void> {
    if (symbol === this.symbol) return;
    this.symbol = symbol;
    this.buffer = [];
    this.contracts = [];
    this.contractsSource = null;
    this.contractsSymbol = null;
    if (this.subscriptionId) await this.pub.forget(this.subscriptionId);
    this.subscriptionId = null;
    if (this.pub.isOpen()) await this.bootstrap();
  }

  /** Atualiza a lista de contratos com a visão da conta autenticada (mais precisa). */
  async refreshContractsFrom(sock: DerivSocket, source: 'public' | 'account'): Promise<void> {
    const symbol = this.symbol;
    const r = await sock.send<ContractsForResponse>({ contracts_for: symbol });
    if (symbol !== this.symbol) return;
    // não substitui a visão da conta pela visão pública para o mesmo símbolo
    if (source === 'public' && this.contractsSource === 'account' && this.contractsSymbol === symbol) return;
    this.contractsSymbol = symbol;
    this.contracts = r.contracts_for?.available ?? [];
    this.contractsSource = source;
    this.contractsFetchedAt = new Date().toISOString();
    this.audit.record('info', 'market_data', 'contracts_for', `${this.contracts.length} contratos disponíveis para ${this.symbol} (${source === 'account' ? 'visão da conta' : 'canal público'})`);
  }

  private async bootstrap(): Promise<void> {
    const gen = ++this.generation;
    const symbol = this.symbol;
    this.registry.update('market_data', { status: 'waiting', detail: 'consultando active_symbols' });
    try {
      const as = await this.pub.send<ActiveSymbolsResponse>({ active_symbols: 'brief' });
      if (gen !== this.generation) return;
      this.symbols = as.active_symbols ?? [];
      this.symbolsFetchedAt = new Date().toISOString();
      this.registry.count('market_data', 'active_symbols');
      const info = this.symbols.find((s) => s.underlying_symbol === symbol) ?? null;
      this.symbolInfo = info;
      if (!info) {
        this.registry.update('market_data', { status: 'error', detail: `símbolo ${symbol} não oferecido pela Deriv`, lastError: 'símbolo indisponível' });
        this.audit.record('error', 'market_data', 'symbol_unavailable', `O símbolo ${symbol} não aparece em active_symbols (${this.symbols.length} símbolos retornados). Escolha outro nas configurações.`);
        return;
      }
      if (info.exchange_is_open !== 1 || info.is_trading_suspended === 1) {
        this.audit.record('warn', 'market_data', 'market_closed', `${symbol}: mercado ${info.exchange_is_open === 1 ? 'aberto' : 'fechado'}, negociação ${info.is_trading_suspended ? 'suspensa' : 'ativa'}`);
      }

      this.registry.update('market_data', { status: 'waiting', detail: `carregando histórico de ${symbol}` });
      const h = await this.pub.send<TicksHistoryResponse>({ ticks_history: symbol, end: 'latest', count: 500, style: 'ticks' });
      if (gen !== this.generation) return;
      const now = Date.now();
      const prices = h.history?.prices ?? [];
      const times = h.history?.times ?? [];
      const hist: NormalizedTick[] = [];
      for (let i = 0; i < Math.min(prices.length, times.length); i++) {
        const t = normalizeTick({ quote: prices[i], epoch: times[i], symbol, pip_size: h.pip_size ?? info.pip_size }, symbol, now, 'deriv:ticks_history');
        if (t && (hist.length === 0 || t.epoch > hist.at(-1)!.epoch)) hist.push(t);
      }
      this.buffer = hist.slice(-BUFFER);
      this.audit.record('info', 'market_data', 'history_loaded', `${hist.length} cotações históricas de ${symbol} carregadas (ticks_history)`);

      try {
        if (this.accountSocket?.isOpen()) await this.refreshContractsFrom(this.accountSocket, 'account');
        else await this.refreshContractsFrom(this.pub, 'public');
      }
      catch (e) { this.audit.record('warn', 'market_data', 'contracts_for_failed', `contracts_for falhou: ${(e as Error).message}`); }
      if (gen !== this.generation) return;

      const sub = await this.pub.subscribe<TickResponse>({ ticks: symbol }, (m) => this.onTick(m, symbol));
      if (gen !== this.generation) { if (sub.subscriptionId) await this.pub.forget(sub.subscriptionId); return; }
      this.subscriptionId = sub.subscriptionId;
      this.onTick(sub.first, symbol);
      this.registry.update('market_data', { status: 'ok', detail: `recebendo ticks de ${symbol}`, lastError: null });
      this.emit('ready');
    } catch (e) {
      if (gen !== this.generation) return;
      const msg = (e as Error).message;
      this.registry.update('market_data', { status: 'error', detail: 'falha na inicialização do feed', lastError: msg });
      this.audit.record('error', 'market_data', 'bootstrap_failed', `Falha ao iniciar feed de ${symbol}: ${msg}`);
    }
  }

  private onTick(m: TickResponse, symbol: string): void {
    if (symbol !== this.symbol) return;
    const t = normalizeTick(m.tick, symbol, Date.now(), 'deriv:ticks');
    if (!t) { this.registry.count('market_data', 'ticks_invalidos'); return; }
    const last = this.buffer.at(-1);
    if (last && t.epoch <= last.epoch) { this.registry.count('market_data', 'ticks_repetidos'); return; }
    this.buffer.push(t);
    if (this.buffer.length > BUFFER) this.buffer.splice(0, this.buffer.length - BUFFER);
    this.registry.count('market_data', 'ticks');
    this.registry.update('market_data', { status: 'ok', detail: `${symbol} ${t.quote.toFixed(t.pipSize)} @ ${new Date(t.epoch * 1000).toISOString().slice(11, 19)} UTC` });
    this.emit('tick', t);
  }
}
