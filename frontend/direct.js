// =====================================================================
// MODO DIRETO — o navegador conecta ao canal PÚBLICO oficial da Deriv
// (wss://api.derivws.com/trading/v1/options/ws/public) sem servidor próprio.
// Usado quando o painel está hospedado só como site estático (Vercel, Pages).
//
// Dados: 100% Deriv (active_symbols, ticks_history, ticks, contracts_for).
// Análise e estratégia: o MESMO código do backend (frontend/lib, gerado).
// Limites honestos: sem saldo, sem ordens, e a análise só roda com a aba aberta.
// =====================================================================
import { analyze } from './lib/agents/analyzer.js';
import { evaluate } from './lib/strategies/engine.js';
import { SignalValidator } from './lib/agents/validator.js';
import { DEFAULT_SETTINGS, mergeAndValidate } from './lib/settings.js';

export const DERIV_PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';
const BUFFER = 1000;
const ENGINE_PT = { RUNNING: 'em execução', PAUSED: 'pausado', STOPPED: 'parado' };

const META = {
  market_data: ['Market Data', 'Recebe e normaliza cotações da Deriv'],
  market_analyzer: ['Market Analyzer', 'Calcula tendência, EMA, RSI e volatilidade'],
  strategy_engine: ['Strategy Engine', 'Aplica as regras da estratégia selecionada'],
  signal_validator: ['Signal Validator', 'Valida oportunidades e bloqueia duplicatas'],
  risk_manager: ['Risk Manager', 'Limites de exposição, perda diária e bloqueios'],
  execution_engine: ['Execution Engine', 'Envia propostas e ordens autorizadas'],
  portfolio_monitor: ['Portfolio Monitor', 'Acompanha contratos, saldo e resultados'],
  audit: ['Audit Agent', 'Registra eventos e decisões'],
  supervisor: ['Supervisor', 'Coordena módulos e interrompe entradas em falhas'],
};
const SERVER_ONLY = new Set(['risk_manager', 'execution_engine', 'portfolio_monitor']);

function load(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* armazenamento indisponível */ } }

export class DirectEngine {
  constructor({ url } = {}) {
    this.url = url || DERIV_PUBLIC_WS;
    this.listeners = new Set();
    this.reqId = 1;
    this.pending = new Map();
    this.status = 'idle';
    this.lastError = null;
    this.reconnects = 0;
    this.connectedAt = null;
    this.lastMessageAt = null;
    this.attempt = 0;
    this.symbols = [];
    this.symbolsFetchedAt = null;
    this.symbolInfo = null;
    this.contracts = [];
    this.contractsFetchedAt = null;
    this.buffer = [];
    this.events = [];
    this.recentDecisions = [];
    this.signals = [];
    this.analysis = null;
    this.decision = null;
    this.validator = new SignalValidator();
    this.startedAt = new Date().toISOString();
    try { this.settings = mergeAndValidate(structuredClone(DEFAULT_SETTINGS), { ...load('otc.direct.settings', {}), executionMode: 'signals' }); }
    catch { this.settings = structuredClone(DEFAULT_SETTINGS); }
    this.engineStatus = load('otc.direct.status', 'STOPPED');
    this.agents = {};
    for (const [id, [name, role]] of Object.entries(META)) {
      this.agents[id] = { id, name, role, status: SERVER_ONLY.has(id) ? 'stopped' : 'idle', detail: SERVER_ONLY.has(id) ? 'requer o motor no servidor (não roda no navegador)' : 'aguardando conexão', lastActivityAt: null, counters: {}, lastError: null };
    }
    this.agent('audit', { status: 'ok', detail: 'registrando eventos nesta aba (memória)' }, false);
  }

  // ------------------------------------------------------------ infraestrutura
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { if (this._t) return; this._t = setTimeout(() => { this._t = null; const s = this.state(); for (const f of this.listeners) f(s); }, 150); }
  agent(id, patch, activity = true) { Object.assign(this.agents[id], patch); if (activity) this.agents[id].lastActivityAt = new Date().toISOString(); }
  count(id, k) { const c = this.agents[id].counters; c[k] = (c[k] || 0) + 1; }
  log(level, agent, type, message) {
    this.events.unshift({ id: Date.now() + Math.random(), ts: new Date().toISOString(), level, agent, type, message, data: null });
    if (this.events.length > 300) this.events.length = 300;
    this.count('audit', 'eventos');
    this.agent('audit', { detail: `último: ${type}` });
  }

  start() {
    if (this.ws) return;
    this.open();
    this.watchdog = setInterval(() => {
      if (this.status === 'open' && this.lastMessageAt && Date.now() - this.lastMessageAt > 75000) this.fail('sem dados da Deriv há 75 s — reconectando');
      this.evaluateHalts(); this.emit();
    }, 5000);
    this.log('info', 'supervisor', 'boot', 'Modo direto iniciado: conectando ao canal público oficial da Deriv a partir deste navegador');
  }

  open() {
    this.status = this.attempt ? 'reconnecting' : 'connecting';
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.fail(`WebSocket recusado: ${e.message}`); return; }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.status = 'open'; this.connectedAt = Date.now(); this.lastMessageAt = Date.now(); this.attempt = 0; this.lastError = null;
      this.ping = setInterval(() => this.send({ ping: 1 }).catch(() => {}), 30000);
      this.log('info', 'market_data', 'connected', 'Conectado ao canal público da Deriv');
      this.bootstrap();
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this.onMessage(ev.data); };
    ws.onerror = () => { if (this.ws === ws) this.lastError = 'erro de WebSocket'; };
    ws.onclose = (ev) => { if (this.ws === ws) this.fail(`conexão encerrada (code ${ev.code})`); };
    this.emit();
  }

  fail(reason) {
    this.lastError = reason;
    clearInterval(this.ping);
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch { /* já fechado */ } }
    for (const [, p] of this.pending) p.reject(new Error('conexão encerrada'));
    this.pending.clear();
    this.subId = null;
    this.connectedAt = null;
    this.status = 'reconnecting';
    this.reconnects++;
    const delay = [1000, 2000, 4000, 8000, 16000, 30000][Math.min(this.attempt++, 5)] * (0.8 + Math.random() * 0.4);
    this.agent('market_data', { status: 'degraded', detail: 'desconectado da Deriv — reconectando', lastError: reason });
    this.log('warn', 'market_data', 'disconnected', `Canal público caiu: ${reason}`);
    this.evaluateHalts(); this.emit();
    setTimeout(() => this.open(), delay);
  }

  send(req, timeoutMs = 15000) {
    const ws = this.ws;
    if (!ws || this.status !== 'open') return Promise.reject(new Error('não conectado'));
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`tempo esgotado (${Object.keys(req)[0]})`)); }, timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      ws.send(JSON.stringify({ ...req, req_id: id }));
    });
  }

  onMessage(raw) {
    this.lastMessageAt = Date.now();
    let m; try { m = JSON.parse(raw); } catch { return; }
    const p = typeof m.req_id === 'number' ? this.pending.get(m.req_id) : null;
    if (p) {
      this.pending.delete(m.req_id);
      const err = m.error || (Array.isArray(m.errors) && m.errors[0]);
      if (err) p.reject(new Error(`${err.code || 'Erro'}: ${err.message || ''}`)); else p.resolve(m);
      return;
    }
    if (m.msg_type === 'tick' && m.subscription && m.subscription.id === this.subId) this.onTick(m.tick);
  }

  // ------------------------------------------------------------ mercado (dados reais)
  async bootstrap() {
    const symbol = this.settings.symbol;
    try {
      this.agent('market_data', { status: 'waiting', detail: 'consultando active_symbols' });
      const as = await this.send({ active_symbols: 'brief' });
      this.symbols = as.active_symbols || [];
      this.symbolsFetchedAt = new Date().toISOString();
      this.symbolInfo = this.symbols.find((s) => s.underlying_symbol === symbol) || null;
      if (!this.symbolInfo) {
        this.agent('market_data', { status: 'error', detail: `símbolo ${symbol} não oferecido pela Deriv`, lastError: 'símbolo indisponível' });
        this.log('error', 'market_data', 'symbol_unavailable', `${symbol} não consta em active_symbols (${this.symbols.length} símbolos). Escolha outro em CONFIGURAÇÕES.`);
        this.emit(); return;
      }
      const h = await this.send({ ticks_history: symbol, end: 'latest', count: 500, style: 'ticks' });
      const now = Date.now();
      const prices = (h.history && h.history.prices) || [], times = (h.history && h.history.times) || [];
      const hist = [];
      for (let i = 0; i < Math.min(prices.length, times.length); i++) {
        if (typeof prices[i] === 'number' && prices[i] > 0 && Number.isInteger(times[i]) && (!hist.length || times[i] > hist[hist.length - 1].epoch)) {
          hist.push({ symbol, epoch: times[i], quote: prices[i], pipSize: h.pip_size ?? this.symbolInfo.pip_size ?? 2, receivedAt: now, source: 'deriv:ticks_history' });
        }
      }
      this.buffer = hist.slice(-BUFFER);
      this.log('info', 'market_data', 'history_loaded', `${hist.length} cotações históricas de ${symbol} (ticks_history)`);
      try {
        const cf = await this.send({ contracts_for: symbol });
        this.contracts = (cf.contracts_for && cf.contracts_for.available) || [];
        this.contractsFetchedAt = new Date().toISOString();
      } catch (e) { this.log('warn', 'market_data', 'contracts_for_failed', `contracts_for: ${e.message}`); }
      const sub = await this.send({ ticks: symbol, subscribe: 1 });
      this.subId = sub.subscription ? sub.subscription.id : null;
      this.onTick(sub.tick);
      this.agent('market_data', { status: 'ok', detail: `recebendo ticks de ${symbol}`, lastError: null });
    } catch (e) {
      this.agent('market_data', { status: 'error', detail: 'falha ao iniciar o feed', lastError: e.message });
      this.log('error', 'market_data', 'bootstrap_failed', `Falha ao iniciar feed de ${symbol}: ${e.message}`);
    }
    this.evaluateHalts(); this.emit();
  }

  onTick(t) {
    const symbol = this.settings.symbol;
    if (!t || typeof t.quote !== 'number' || !(t.quote > 0) || !Number.isInteger(t.epoch) || t.symbol !== symbol) { this.count('market_data', 'ticks_invalidos'); return; }
    const last = this.buffer[this.buffer.length - 1];
    if (last && t.epoch <= last.epoch) { this.count('market_data', 'ticks_repetidos'); return; }
    const tick = { symbol, epoch: t.epoch, quote: t.quote, pipSize: typeof t.pip_size === 'number' ? t.pip_size : 2, receivedAt: Date.now(), source: 'deriv:ticks' };
    this.buffer.push(tick);
    if (this.buffer.length > BUFFER) this.buffer.splice(0, this.buffer.length - BUFFER);
    this.count('market_data', 'ticks');
    this.agent('market_data', { status: 'ok', detail: `${symbol} ${tick.quote.toFixed(tick.pipSize)} @ ${new Date(tick.epoch * 1000).toISOString().slice(11, 19)} UTC` });
    if (this.engineStatus === 'RUNNING') this.process(tick);
    else for (const id of ['market_analyzer', 'strategy_engine']) this.agent(id, { status: 'stopped', detail: `motor ${ENGINE_PT[this.engineStatus]}` }, false);
    this.emit();
  }

  process(tick) {
    const s = this.settings;
    const a = analyze(this.buffer, s);
    this.analysis = a;
    this.count('market_analyzer', 'analises');
    this.agent('market_analyzer', { status: 'ok', detail: `tendência ${a.trend}, RSI ${a.rsi != null ? a.rsi.toFixed(1) : '—'}, vol ${a.volatilityPct != null ? a.volatilityPct.toFixed(4) : '—'}%` });
    const d = evaluate(s, a);
    this.decision = { ...d, at: new Date().toISOString(), tickEpoch: tick.epoch };
    this.recentDecisions.unshift(this.decision);
    if (this.recentDecisions.length > 50) this.recentDecisions.length = 50;
    this.count('strategy_engine', d.action === 'AGUARDAR' ? 'aguardar' : 'sinais');
    this.agent('strategy_engine', { status: d.action === 'AGUARDAR' ? 'waiting' : 'ok', detail: `${d.action}: ${d.reason}` });
    if (d.action === 'AGUARDAR') return;
    const v = this.validator.validate(d, tick, s, this.symbolInfo, this.contracts);
    this.count('signal_validator', v.ok ? 'aprovados' : 'rejeitados');
    this.agent('signal_validator', { status: v.ok ? 'ok' : 'waiting', detail: `${v.ok ? 'aprovado' : 'rejeitado'}: ${v.reason}` });
    this.signals.unshift({ id: this.signals.length + 1, ts: new Date().toISOString(), symbol: tick.symbol, strategy: s.strategy, tick_epoch: tick.epoch, action: d.action, reason: d.reason, indicators: JSON.stringify(d.indicators), verdict: v.ok ? 'signal_only' : 'rejected', verdict_reason: v.ok ? 'modo direto — nenhuma ordem enviada' : v.reason });
    if (this.signals.length > 500) this.signals.length = 500;
    this.log('info', 'strategy_engine', 'signal', `Sinal ${d.action} em ${tick.symbol} (${d.reason}) — ${v.ok ? 'válido' : 'rejeitado: ' + v.reason}. Nenhuma ordem enviada (modo direto).`);
  }

  evaluateHalts() {
    const r = [];
    const last = this.buffer[this.buffer.length - 1];
    const age = last ? Date.now() - last.receivedAt : null;
    if (this.status !== 'open') r.push('canal público da Deriv desconectado');
    else if (age === null) r.push('nenhuma cotação recebida ainda');
    else if (age > this.settings.risk.maxTickAgeSeconds * 3000) r.push(`feed parado há ${(age / 1000).toFixed(0)} s`);
    this.haltReasons = r;
    this.agent('supervisor', { status: r.length ? (this.engineStatus === 'RUNNING' ? 'degraded' : 'stopped') : (this.engineStatus === 'RUNNING' ? 'ok' : 'stopped'), detail: r.length ? r[0] : `análise ${ENGINE_PT[this.engineStatus]} (somente sinais)` }, false);
  }

  // ------------------------------------------------------------ estado no formato da API do servidor
  state() {
    const last = this.buffer[this.buffer.length - 1] || null;
    const today = new Date().toISOString().slice(0, 10);
    return {
      direct: true,
      serverTime: new Date().toISOString(),
      engine: { status: this.engineStatus, haltReasons: this.haltReasons || [], startedAt: this.startedAt, allowRealTrading: false },
      connection: {
        public: { name: 'public', status: this.status, connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null, lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null, reconnects: this.reconnects, lastError: this.lastError, pendingRequests: this.pending.size, activeStreams: this.subId ? 1 : 0 },
        account: null,
        credentialsConfigured: false,
      },
      account: null,
      market: {
        symbol: this.settings.symbol, symbolInfo: this.symbolInfo,
        lastTick: last ? { ...last, receivedAt: new Date(last.receivedAt).toISOString() } : null,
        ticks: this.buffer.slice(-300).map((x) => [x.epoch, x.quote]),
        contracts: this.contracts.filter((c) => c.contract_type === 'CALL' || c.contract_type === 'PUT').map((c) => ({ contract_type: c.contract_type, expiry_type: c.expiry_type, min: c.min_contract_duration, max: c.max_contract_duration, barriers: c.barriers })),
        contractsSource: this.contractsFetchedAt ? 'public' : null, contractsFetchedAt: this.contractsFetchedAt,
      },
      analysis: this.analysis, decision: this.decision, recentDecisions: this.recentDecisions.slice(0, 20), risk: null,
      pnl: { day: today, mode: 'signals', realized: 0, settled: 0, wins: 0, losses: 0, unrealized: null, source: 'modo direto não envia ordens — não há resultado a contabilizar' },
      positions: [], agents: Object.values(this.agents).map((a) => structuredClone(a)), settings: this.settings, trades: [], events: this.events.slice(0, 40),
    };
  }

  // ------------------------------------------------------------ rotas equivalentes à API do servidor
  async handle(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const [p, q] = path.split('?');
    const params = new URLSearchParams(q || '');
    if (method === 'GET' && p === '/api/state') return this.state();
    if (method === 'POST' && p.startsWith('/api/control/')) {
      const cmd = p.split('/').pop();
      if (cmd === 'ack') return { haltReasons: this.haltReasons || [] };
      const next = { start: 'RUNNING', pause: 'PAUSED', stop: 'STOPPED' }[cmd];
      if (!next) throw new Error('comando inválido');
      this.engineStatus = next; save('otc.direct.status', next);
      this.log('info', 'supervisor', 'command', `Comando ${cmd.toUpperCase()} → análise ${ENGINE_PT[next]} (modo direto, sem ordens)`);
      this.evaluateHalts(); this.emit();
      return { status: next };
    }
    if (method === 'PUT' && p === '/api/settings') {
      const body = JSON.parse(opts.body || '{}');
      const patch = body.settings || {};
      if (patch.executionMode && patch.executionMode !== 'signals') throw new Error('O modo direto (sem servidor) só gera sinais. Ordens na conta demo exigem o motor rodando num servidor.');
      const next = mergeAndValidate(this.settings, { ...patch, executionMode: 'signals' });
      const changed = next.symbol !== this.settings.symbol;
      this.settings = next; save('otc.direct.settings', next);
      this.log('info', 'supervisor', 'settings', 'Configurações salvas neste aparelho');
      if (changed) { this.buffer = []; this.analysis = null; this.decision = null; this.contracts = []; if (this.subId) this.send({ forget: this.subId }).catch(() => {}); this.subId = null; if (this.status === 'open') this.bootstrap(); }
      this.emit();
      return next;
    }
    if (method === 'GET' && p === '/api/symbols') return { fetchedAt: this.symbolsFetchedAt, source: 'deriv:active_symbols', symbols: this.symbols };
    if (method === 'GET' && p === '/api/trades') return [];
    if (method === 'GET' && p === '/api/decisions') return this.signals.slice(0, Number(params.get('limit')) || 100);
    if (method === 'GET' && p === '/api/events') {
      const before = Number(params.get('before'));
      const list = before ? this.events.filter((e) => e.id < before) : this.events;
      return list.slice(0, Number(params.get('limit')) || 100);
    }
    if (method === 'GET' && p === '/api/diagnostics') {
      const last = this.buffer[this.buffer.length - 1];
      const age = last ? Date.now() - last.receivedAt : null;
      return {
        at: new Date().toISOString(),
        checks: [
          { name: 'Modo', ok: true, detail: 'DIRETO — este navegador conecta à Deriv sem servidor próprio' },
          { name: 'Canal público Deriv', ok: this.status === 'open', detail: `${this.status}${this.lastError ? ' — ' + this.lastError : ''} (${this.url})` },
          { name: 'Cotações ao vivo', ok: age !== null && age < 15000, detail: age === null ? 'nenhuma recebida' : `última há ${(age / 1000).toFixed(1)} s` },
          { name: `Símbolo ${this.settings.symbol} em active_symbols`, ok: Boolean(this.symbolInfo), detail: this.symbolInfo ? `${this.symbolInfo.underlying_symbol_name} (${this.symbolInfo.market})` : `${this.symbols.length} símbolos consultados` },
          { name: 'contracts_for', ok: this.contracts.length > 0, detail: `${this.contracts.length} contratos (canal público)` },
          { name: 'Saldo e ordens', ok: false, detail: 'indisponíveis no modo direto — exigem o motor num servidor com credenciais Deriv' },
          { name: 'Funcionamento contínuo', ok: false, detail: 'a análise para quando esta aba é fechada ou o iPhone bloqueia a tela' },
        ],
        sockets: [this.state().connection.public],
        haltReasons: this.haltReasons || [],
      };
    }
    throw new Error('Indisponível no modo direto');
  }
}
