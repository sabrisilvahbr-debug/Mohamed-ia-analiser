import { EventEmitter } from 'node:events';
import type { AppConfig } from '../config.ts';
import { hasDerivCredentials } from '../config.ts';
import { DerivSocket, type WsFactory } from '../deriv/client.ts';
import { listAccounts, modeFromWsUrl, requestOtpUrl, type AccountMode } from '../deriv/auth.ts';
import type { DesiredState, Store } from '../db.ts';
import { mergeAndValidate, type Settings } from '../settings.ts';
import { evaluate, type Analysis, type Decision } from '../strategies/engine.ts';
import { analyze } from './analyzer.ts';
import { AuditAgent } from './audit.ts';
import { AgentRegistry } from './base.ts';
import { ExecutionEngine } from './execution.ts';
import { MarketDataAgent, type NormalizedTick } from './marketData.ts';
import { PortfolioMonitor } from './portfolio.ts';
import { checkRisk, type RiskVerdict } from './risk.ts';
import { SignalValidator } from './validator.ts';

export type EngineStatus = 'RUNNING' | 'PAUSED' | 'STOPPED';

export interface SupervisorDeps {
  config: AppConfig;
  store: Store;
  wsFactory?: WsFactory;
  fetchImpl?: typeof fetch;
  /** tempo limite padrão das requisições (ms) */
  requestTimeoutMs?: number;
  /** tempo limite da compra (ms) */
  buyTimeoutMs?: number;
  backoffMs?: number[];
}

/**
 * Agente 9 — Supervisor. Coordena os demais agentes:
 *  - Market Data e Portfolio Monitor funcionam sempre (cotações e contratos abertos continuam visíveis)
 *  - análise/estratégia/execução só rodam em RUNNING
 *  - falhas críticas (feed parado, ordem sem confirmação, resultado inconsistente, banco) bloqueiam novas entradas
 *  - PARAR impede novas ordens; contratos existentes seguem até a liquidação pela Deriv (não há cancelamento presumido)
 */
export class Supervisor extends EventEmitter {
  readonly registry = new AgentRegistry();
  readonly audit: AuditAgent;
  readonly market: MarketDataAgent;
  readonly portfolio: PortfolioMonitor;
  readonly execution: ExecutionEngine;
  readonly validator = new SignalValidator();
  readonly pub: DerivSocket;
  readonly auth: DerivSocket | null;
  status: EngineStatus;
  settings: Settings;
  accountMode: AccountMode | null = null;
  lastAnalysis: Analysis | null = null;
  lastDecision: (Decision & { at: string; tickEpoch: number }) | null = null;
  lastRisk: RiskVerdict | null = null;
  /** Últimas decisões (inclusive AGUARDAR), mantidas em memória para o painel. */
  recentDecisions: (Decision & { at: string; tickEpoch: number })[] = [];
  haltReasons: string[] = [];
  readonly startedAt = new Date().toISOString();
  private manualHalts = new Set<string>();
  private watchdog: NodeJS.Timeout | null = null;
  private readonly cfg: AppConfig;
  private readonly store: Store;
  private readonly fetchImpl: typeof fetch;

  constructor(d: SupervisorDeps) {
    super();
    this.cfg = d.config;
    this.store = d.store;
    this.fetchImpl = d.fetchImpl ?? fetch;
    this.audit = new AuditAgent(d.store, this.registry);
    this.settings = d.store.getSettings();
    this.status = d.store.getDesired();

    this.pub = new DerivSocket({ name: 'public', urlProvider: async () => this.cfg.deriv.publicWs, wsFactory: d.wsFactory, requestTimeoutMs: d.requestTimeoutMs, backoffMs: d.backoffMs });
    this.market = new MarketDataAgent(this.pub, this.registry, this.audit, this.settings.symbol);
    this.portfolio = new PortfolioMonitor(d.store, this.registry, this.audit, this.cfg.deriv.appId);
    this.execution = new ExecutionEngine(d.store, this.registry, this.audit, d.buyTimeoutMs);

    if (hasDerivCredentials(this.cfg)) {
      const c = { restBase: this.cfg.deriv.restBase, appId: this.cfg.deriv.appId!, pat: this.cfg.deriv.pat!, accountId: this.cfg.deriv.accountId! };
      this.auth = new DerivSocket({
        name: 'account',
        urlProvider: async () => {
          const url = await requestOtpUrl(c, this.fetchImpl);
          this.accountMode = modeFromWsUrl(url);
          return url;
        },
        wsFactory: d.wsFactory,
        requestTimeoutMs: d.requestTimeoutMs,
        backoffMs: d.backoffMs,
      });
      this.portfolio.attach(this.auth, () => this.accountMode ?? 'desconhecido');
      this.market.accountSocket = this.auth;
      this.auth.on('open', () => {
        this.audit.record('info', 'supervisor', 'account_channel_open', `Canal autenticado aberto (conta ${this.accountMode})`);
        this.market.refreshContractsFrom(this.auth!, 'account').catch((e: Error) => this.audit.record('warn', 'market_data', 'contracts_for_failed', `contracts_for (conta): ${e.message}`));
      });
      this.auth.on('down', (r: string) => this.audit.record('warn', 'supervisor', 'account_channel_down', `Canal da conta caiu: ${r}`));
    } else {
      this.auth = null;
      this.registry.update('portfolio_monitor', { status: 'stopped', detail: 'credenciais Deriv não configuradas — sem saldo e sem ordens', activity: false });
      this.registry.update('execution_engine', { status: 'stopped', detail: 'credenciais Deriv não configuradas', activity: false });
    }

    this.pub.on('down', (r: string) => this.audit.record('warn', 'supervisor', 'public_channel_down', `Canal público caiu: ${r}`));
    this.market.on('tick', (t: NormalizedTick) => this.onTick(t));
    this.portfolio.on('critical', (reason: string) => this.manualHalt(`resultado inconsistente: ${reason}`));
    this.portfolio.on('settled', () => this.checkLossStreak());
    this.audit.on('failure', () => this.evaluateHalts());
    for (const ev of ['balance', 'position', 'settled'] as const) this.portfolio.on(ev, () => this.emit('state'));
    this.registry.on('change', () => this.emit('agents'));
    this.audit.on('event', (e) => this.emit('event', e));
  }

  start(watchdogMs = 5000): void {
    this.portfolio.recoverAfterRestart();
    this.audit.record('info', 'supervisor', 'boot', `Motor iniciado (estado salvo: ${this.status}, modo ${this.settings.executionMode}, credenciais Deriv: ${this.auth ? 'sim' : 'não'})`);
    this.pub.start();
    this.auth?.start();
    this.watchdog = setInterval(() => this.tickWatchdog(), watchdogMs);
    this.evaluateHalts();
  }

  /** Para os canais e aguarda a ordem em andamento ser registrada antes de liberar o banco. */
  async shutdown(maxWaitMs = 3000): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.pub.stop();
    this.auth?.stop();
    const t0 = Date.now();
    while (this.execution.isBusy() && Date.now() - t0 < maxWaitMs) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 30));
  }

  // ------------------------------------------------------------------ comandos
  command(cmd: 'start' | 'pause' | 'stop'): EngineStatus {
    const next: DesiredState = cmd === 'start' ? 'RUNNING' : cmd === 'pause' ? 'PAUSED' : 'STOPPED';
    if (cmd === 'start' && this.settings.executionMode === 'real' && !this.cfg.allowRealTrading) {
      throw new Error('Execução real bloqueada no servidor (ALLOW_REAL_TRADING≠true). Use o modo demo ou sinais.');
    }
    this.store.setDesired(next);
    this.status = next;
    if (cmd === 'start') this.manualHalts.delete('perdas consecutivas');
    this.audit.record('info', 'supervisor', 'command', `Comando ${cmd.toUpperCase()} recebido → ${next}${cmd === 'stop' ? ' (novas ordens bloqueadas; contratos abertos seguem até a liquidação)' : ''}`);
    this.registry.update('supervisor', { status: next === 'RUNNING' ? 'ok' : 'stopped', detail: `motor ${next}` });
    this.evaluateHalts();
    this.emit('state');
    return next;
  }

  updateSettings(patch: unknown, confirmReal: boolean): Settings {
    const next = mergeAndValidate(this.settings, patch);
    if (next.executionMode === 'real' && this.settings.executionMode !== 'real') {
      if (!this.cfg.allowRealTrading) throw new Error('Execução real bloqueada no servidor (ALLOW_REAL_TRADING≠true).');
      if (!confirmReal) throw new Error('Mudar para conta REAL exige confirmação explícita (confirmReal=true).');
    }
    const symbolChanged = next.symbol !== this.settings.symbol;
    this.store.saveSettings(next);
    this.settings = next;
    this.audit.record('info', 'supervisor', 'settings', 'Configurações atualizadas', next);
    if (symbolChanged) void this.market.setSymbol(next.symbol);
    this.emit('state');
    return next;
  }

  /** Limpa bloqueios manuais (ex.: ordem sem confirmação já revisada na Deriv). */
  acknowledgeHalts(): void {
    this.manualHalts.clear();
    this.audit.record('warn', 'supervisor', 'halts_acknowledged', 'Bloqueios manuais reconhecidos pelo operador');
    this.evaluateHalts();
  }

  private manualHalt(reason: string): void {
    this.manualHalts.add(reason);
    this.evaluateHalts();
  }

  private checkLossStreak(): void {
    const n = this.store.consecutiveLosses(this.settings.executionMode);
    if (n >= this.settings.risk.maxConsecutiveLosses && this.status === 'RUNNING') {
      this.status = 'PAUSED';
      this.store.setDesired('PAUSED');
      this.manualHalts.add('perdas consecutivas');
      this.audit.record('critical', 'supervisor', 'auto_pause', `${n} perdas seguidas — motor PAUSADO automaticamente. Revise antes de INICIAR novamente.`);
      this.emit('state');
    }
  }

  // ------------------------------------------------------------------ watchdog
  private tickWatchdog(): void {
    const onErr = (e: Error) => this.audit.record('error', 'supervisor', 'watchdog_error', e.message);
    this.portfolio.syncOpenContracts().catch(onErr);
    if (this.store.listActiveTrades().some((t) => t.state === 'UNCONFIRMED')) this.portfolio.reconcile().catch(onErr);
    this.evaluateHalts();
  }

  evaluateHalts(): void {
    const reasons: string[] = [...this.manualHalts];
    const age = this.market.feedAgeMs();
    if (!this.pub.isOpen()) reasons.push('canal público da Deriv desconectado');
    else if (age === null) reasons.push('nenhuma cotação recebida ainda');
    else if (age > this.settings.risk.maxTickAgeSeconds * 3000) reasons.push(`feed parado há ${(age / 1000).toFixed(0)} s`);
    if (!this.audit.healthy()) reasons.push('falha ao gravar no banco de dados');
    if (this.settings.executionMode !== 'signals') {
      if (!this.auth) reasons.push('credenciais Deriv ausentes para o modo de execução');
      else if (!this.auth.isOpen()) reasons.push('canal autenticado da Deriv desconectado');
    }
    const unconfirmed = this.store.listActiveTrades().filter((t) => t.state === 'UNCONFIRMED').length;
    if (unconfirmed) reasons.push(`${unconfirmed} ordem(ns) sem confirmação`);
    const changed = reasons.join('|') !== this.haltReasons.join('|');
    this.haltReasons = reasons;
    const st = reasons.length ? (this.status === 'RUNNING' ? 'degraded' : 'stopped') : this.status === 'RUNNING' ? 'ok' : 'stopped';
    this.registry.update('supervisor', { status: st, detail: reasons.length ? `entradas bloqueadas: ${reasons[0]}` : `motor ${this.status}`, activity: changed });
    if (changed) {
      if (reasons.length) this.audit.record(this.status === 'RUNNING' ? 'warn' : 'info', 'supervisor', 'halt', `Novas entradas bloqueadas: ${reasons.join('; ')}`);
      else this.audit.record('info', 'supervisor', 'halt_cleared', 'Condições normalizadas — nenhuma trava ativa');
      this.emit('state');
    }
  }

  // ------------------------------------------------------------------ pipeline
  /**
   * Cada cotação passa por análise → estratégia → validação → risco de forma SÍNCRONA
   * (nenhum tick é pulado). Apenas o envio da ordem é assíncrono, protegido pelo mutex
   * do Execution Engine e pelo limite de contratos abertos.
   */
  private onTick(t: NormalizedTick): void {
    this.emit('tick', t);
    if (this.status !== 'RUNNING') {
      this.registry.update('market_analyzer', { status: 'stopped', detail: `motor ${this.status}`, activity: false });
      this.registry.update('strategy_engine', { status: 'stopped', detail: `motor ${this.status}`, activity: false });
      return;
    }
    try { this.process(t); }
    catch (e) {
      this.audit.record('error', 'supervisor', 'pipeline_error', `Erro no ciclo de decisão: ${(e as Error).message}`);
    }
  }

  private process(t: NormalizedTick): void {
    const s = this.settings;
    const a = analyze(this.market.buffer, s);
    this.lastAnalysis = a;
    this.registry.count('market_analyzer', 'analises');
    this.registry.update('market_analyzer', { status: 'ok', detail: `tendência ${a.trend}, RSI ${a.rsi?.toFixed(1) ?? '—'}, vol ${a.volatilityPct?.toFixed(4) ?? '—'}%` });

    const d = evaluate(s, a);
    this.lastDecision = { ...d, at: new Date().toISOString(), tickEpoch: t.epoch };
    this.recentDecisions.unshift(this.lastDecision);
    if (this.recentDecisions.length > 50) this.recentDecisions.length = 50;
    this.registry.count('strategy_engine', d.action === 'AGUARDAR' ? 'aguardar' : 'sinais');
    this.registry.update('strategy_engine', { status: d.action === 'AGUARDAR' ? 'waiting' : 'ok', detail: `${d.action}: ${d.reason}` });
    this.emit('decision', this.lastDecision);
    if (d.action === 'AGUARDAR') return;

    // decisões com sinal são persistidas (UNIQUE symbol+strategy+epoch impede repetição)
    const row = this.store.addDecision({ symbol: t.symbol, strategy: s.strategy, tick_epoch: t.epoch, action: d.action, reason: d.reason, indicators: JSON.stringify(d.indicators), verdict: 'pending', verdict_reason: null });
    if (!row) { this.registry.count('signal_validator', 'duplicados'); return; }

    const v = this.validator.validate(d, t, s, this.market.symbolInfo, this.market.contracts);
    this.registry.count('signal_validator', v.ok ? 'aprovados' : 'rejeitados');
    this.registry.update('signal_validator', { status: v.ok ? 'ok' : 'waiting', detail: `${v.ok ? 'aprovado' : 'rejeitado'}: ${v.reason}` });
    if (!v.ok) { this.store.updateDecisionVerdict(row.id, 'rejected', v.reason); return; }

    this.evaluateHalts();
    const today = new Date().toISOString().slice(0, 10);
    const active = this.store.listActiveTrades();
    const risk = checkRisk(s, {
      executionMode: s.executionMode,
      allowRealTrading: this.cfg.allowRealTrading,
      accountMode: this.auth?.isOpen() ? this.accountMode : null,
      balance: this.portfolio.account?.balance ?? null,
      balanceAgeMs: this.portfolio.account ? Date.now() - Date.parse(this.portfolio.account.receivedAt) : null,
      realizedToday: this.store.realizedForDay(today, s.executionMode).pnl,
      openCount: active.length,
      openExposure: active.reduce((sum, x) => sum + x.stake, 0),
      unconfirmedCount: active.filter((x) => x.state === 'UNCONFIRMED').length,
      consecutiveLosses: this.store.consecutiveLosses(s.executionMode),
      lastEntryAt: this.store.lastEntryTime(),
      now: Date.now(),
    });
    this.lastRisk = risk;
    if (s.executionMode === 'signals') {
      this.store.updateDecisionVerdict(row.id, 'signal_only', 'modo SINAIS — nenhuma ordem enviada');
      this.registry.update('risk_manager', { status: 'ok', detail: 'modo SINAIS (sem ordens)' });
      this.audit.record('info', 'strategy_engine', 'signal', `Sinal ${d.action} em ${t.symbol} (${d.reason}) — modo SINAIS, nenhuma ordem enviada`);
      return;
    }
    if (this.haltReasons.length) {
      this.store.updateDecisionVerdict(row.id, 'blocked', `supervisor: ${this.haltReasons.join('; ')}`);
      this.registry.update('risk_manager', { status: 'waiting', detail: 'bloqueado pelo supervisor' });
      return;
    }
    this.registry.update('risk_manager', { status: risk.ok ? 'ok' : 'waiting', detail: risk.reasons[0] ?? '' });
    if (!risk.ok) { this.store.updateDecisionVerdict(row.id, 'blocked', risk.blocking.join('; ')); return; }
    if (this.execution.isBusy()) { this.store.updateDecisionVerdict(row.id, 'blocked', 'outra ordem em andamento'); return; }

    const acc = this.portfolio.account;
    if (!this.auth || !acc || (this.accountMode !== 'demo' && this.accountMode !== 'real')) {
      this.store.updateDecisionVerdict(row.id, 'blocked', 'conta não identificada');
      return;
    }
    this.store.updateDecisionVerdict(row.id, 'approved', v.signalKey);
    void this.execution.execute(this.auth, {
      signalKey: v.signalKey, contractType: d.action, settings: s, currency: acc.currency, accountMode: this.accountMode, accountId: acc.loginid,
    }).then(async (out) => {
      if (out.kind === 'opened') await this.portfolio.syncOpenContracts();
      if (out.kind === 'unconfirmed') this.evaluateHalts();
      this.emit('state');
    }).catch((e: Error) => this.audit.record('error', 'execution_engine', 'execution_error', `Erro na execução: ${e.message}`));
  }

  // ------------------------------------------------------------------ diagnóstico
  async diagnostics(): Promise<Record<string, unknown>> {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    checks.push({ name: 'ADMIN_TOKEN configurado', ok: Boolean(this.cfg.adminToken), detail: this.cfg.adminToken ? 'sim' : 'não (mínimo 16 caracteres)' });
    checks.push({ name: 'Canal público Deriv', ok: this.pub.isOpen(), detail: `${this.pub.status}${this.pub.lastError ? ' — ' + this.pub.lastError : ''}` });
    const age = this.market.feedAgeMs();
    checks.push({ name: 'Cotações ao vivo', ok: age !== null && age < 15000, detail: age === null ? 'nenhuma recebida' : `última há ${(age / 1000).toFixed(1)} s` });
    checks.push({ name: `Símbolo ${this.settings.symbol} em active_symbols`, ok: Boolean(this.market.symbolInfo), detail: this.market.symbolInfo ? `${this.market.symbolInfo.underlying_symbol_name} (${this.market.symbolInfo.market})` : `${this.market.symbols.length} símbolos consultados` });
    checks.push({ name: 'contracts_for', ok: this.market.contracts.length > 0, detail: `${this.market.contracts.length} contratos (${this.market.contractsSource ?? 'não consultado'})` });
    checks.push({ name: 'Credenciais Deriv (APP_ID, PAT, ACCOUNT_ID)', ok: Boolean(this.auth), detail: this.auth ? 'configuradas no servidor' : 'ausentes — apenas dados públicos' });
    if (this.auth) {
      checks.push({ name: 'Canal autenticado (OTP)', ok: this.auth.isOpen(), detail: `${this.auth.status}, conta ${this.accountMode ?? '?'}${this.auth.lastError ? ' — ' + this.auth.lastError : ''}` });
      checks.push({ name: 'Saldo recebido', ok: Boolean(this.portfolio.account), detail: this.portfolio.account ? `${this.portfolio.account.balance} ${this.portfolio.account.currency} em ${this.portfolio.account.receivedAt}` : 'não' });
      try {
        const r = await listAccounts({ restBase: this.cfg.deriv.restBase, appId: this.cfg.deriv.appId!, pat: this.cfg.deriv.pat!, accountId: this.cfg.deriv.accountId! }, this.fetchImpl);
        checks.push({ name: 'REST GET /accounts', ok: r.ok, detail: r.summary });
      } catch (e) {
        checks.push({ name: 'REST GET /accounts', ok: false, detail: (e as Error).message });
      }
    }
    checks.push({ name: 'Execução real', ok: true, detail: this.cfg.allowRealTrading ? 'PERMITIDA no servidor' : 'bloqueada (padrão)' });
    checks.push({ name: 'Banco de dados', ok: this.audit.healthy(), detail: this.cfg.dbPath });
    return { at: new Date().toISOString(), checks, sockets: [this.pub.info(), this.auth?.info() ?? null].filter(Boolean), haltReasons: this.haltReasons };
  }
}
