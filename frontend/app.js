// =====================================================================
// AI OTC TRADER — painel. Todos os valores exibidos vêm do backend, que
// por sua vez os recebe da API da Deriv. Quando um dado não existe, o
// painel mostra "indisponível" e o motivo — nunca um número inventado.
// =====================================================================
import { Tradefloor, webgl2Available } from './scene3d.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fmt = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const hhmmss = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour12: false }) : '—');
const ago = (iso) => { if (!iso) return '—'; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? `há ${s.toFixed(0)} s` : s < 3600 ? `há ${(s / 60).toFixed(0)} min` : `há ${(s / 3600).toFixed(1)} h`; };

const STATUS_PT = { ok: 'OK', waiting: 'aguardando', degraded: 'degradado', error: 'erro', stopped: 'parado', idle: 'ocioso' };
const ENGINE_PT = { RUNNING: 'EM EXECUÇÃO', PAUSED: 'PAUSADO', STOPPED: 'PARADO' };
const MODE_PT = { signals: 'SINAIS (sem ordens)', demo: 'DEMO (conta demo Deriv)', real: 'REAL' };
const STATE_PT = { PROPOSAL_REQUESTED: 'proposta pedida', PROPOSAL_RECEIVED: 'proposta recebida', BUY_SENT: 'compra enviada', OPEN: 'aberto', SETTLED: 'liquidado', REJECTED: 'recusado', ERROR: 'erro', UNCONFIRMED: 'SEM CONFIRMAÇÃO' };

// ---------------------------------------------------------------- autenticação
let token = localStorage.getItem('otc.admin') || sessionStorage.getItem('otc.admin') || '';
// Endereço do motor. Vazio = mesmo servidor que entregou o painel.
// No Cloudflare Pages o painel é estático e o motor roda na VM (ex.: https://129-1-2-3.sslip.io).
let server = localStorage.getItem('otc.server') || '';
const base = () => server;

function normalizeServer(raw) {
  const t = raw.trim().replace(/\/+$/, '');
  if (!t) return '';
  const u = new URL(/^https?:\/\//.test(t) ? t : 'https://' + t);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error('Use um endereço https://');
  return u.origin;
}

/** O painel foi entregue pelo próprio motor? (então não precisa pedir o endereço) */
async function sameOriginEngine() {
  try { const r = await fetch('/health', { cache: 'no-store' }); if (!r.ok) return false; const j = await r.json(); return j && j.ok === true; } catch { return false; }
}

async function api(path, opts = {}) {
  const res = await fetch(base() + path, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401) { logout('Sessão inválida. Entre novamente.'); throw new Error('não autorizado'); }
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) { const err = new Error(body?.error || `HTTP ${res.status}`); err.issues = body?.issues; throw err; }
  return body;
}

function logout(msg) {
  token = '';
  localStorage.removeItem('otc.admin'); sessionStorage.removeItem('otc.admin');
  streamAbort?.abort();
  $('#app').hidden = true; $('#login').hidden = false;
  $('#login-error').textContent = msg || '';
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = $('#login-token').value.trim();
  token = t;
  if (!$('#login-server-wrap').hidden) {
    try { server = normalizeServer($('#login-server').value); } catch (err) { $('#login-error').textContent = err.message; return; }
    if (!server) { $('#login-error').textContent = 'Informe o endereço do motor.'; return; }
  }
  try {
    const r = await fetch(base() + '/api/state', { headers: { Authorization: `Bearer ${t}` } });
    if (r.status === 503) { $('#login-error').textContent = (await r.json()).error; return; }
    if (!r.ok) { $('#login-error').textContent = r.status === 429 ? 'Muitas tentativas. Aguarde 1 minuto.' : 'Token inválido.'; return; }
    ($('#login-remember').checked ? localStorage : sessionStorage).setItem('otc.admin', t);
    if (server) localStorage.setItem('otc.server', server); else localStorage.removeItem('otc.server');
    $('#login-token').value = '';
    boot(await r.json());
  } catch { $('#login-error').textContent = `Motor inacessível${server ? ' em ' + server : ''}. Verifique o endereço e se a VM está ligada.`; }
});

// ---------------------------------------------------------------- 3D
let floor = null;
let quality = localStorage.getItem('otc.quality') || 'auto';
function setupFloor() {
  const stage = $('.stage');
  floor?.destroy(); floor = null;
  if (quality === 'off' || !webgl2Available()) {
    stage.classList.add('off'); $('#floor3d').hidden = true;
    const fb = $('#stage-fallback'); fb.hidden = false;
    fb.textContent = webgl2Available() ? '3D desligado para economizar bateria. Os dados continuam atualizando abaixo.' : 'Este navegador não oferece WebGL2 — o painel funciona normalmente sem o 3D.';
  } else {
    stage.classList.remove('off'); $('#floor3d').hidden = false; $('#stage-fallback').hidden = true;
    try {
      floor = new Tradefloor($('#floor3d'), { quality, onSelect: selectAgent });
      floor.start();
    } catch (err) {
      $('#floor3d').hidden = true; const fb = $('#stage-fallback'); fb.hidden = false; fb.textContent = `3D indisponível: ${err.message}`;
    }
  }
  for (const b of document.querySelectorAll('[data-quality]')) b.classList.toggle('active', b.dataset.quality === (floor?.quality ?? 'off'));
  if (state) renderFloor(state);
}
document.querySelectorAll('[data-quality]').forEach((b) => b.addEventListener('click', () => { quality = b.dataset.quality; localStorage.setItem('otc.quality', quality); setupFloor(); }));
$('#cam-reset').addEventListener('click', () => selectAgent(null));
document.addEventListener('visibilitychange', () => { if (!floor) return; if (document.hidden) floor.stop(); else floor.start(); });

let selected = null;
function selectAgent(id) {
  selected = id;
  floor?.focus(id);
  renderFocus();
}
function renderFocus() {
  const box = $('#agent-focus');
  const a = state?.agents.find((x) => x.id === selected);
  if (!a) { box.hidden = true; return; }
  box.hidden = false; box.replaceChildren();
  const h = el('h3'); h.append(el('span', `dot st-${a.status}`), document.createTextNode(a.name)); box.append(h);
  box.append(el('div', 'muted', a.role), el('div', '', `Estado: ${STATUS_PT[a.status] ?? a.status}`), el('div', '', a.detail));
  const counters = Object.entries(a.counters || {}).map(([k, v]) => `${k}: ${v}`).join(' • ');
  if (counters) box.append(el('div', 'muted', counters));
  if (a.lastError) box.append(el('div', 'error', `Último erro: ${a.lastError}`));
  box.append(el('div', 'src', `última atividade: ${a.lastActivityAt ? hhmmss(a.lastActivityAt) + ' (' + ago(a.lastActivityAt) + ')' : 'nenhuma'}`));
}

function renderFloor(s) {
  if (!floor) return;
  floor.setAgents(s.agents);
  const sym = s.market.symbolInfo?.underlying_symbol_name ? `${s.market.symbol} • ${s.market.symbolInfo.underlying_symbol_name}` : s.market.symbol;
  floor.setTicks(s.market.ticks, sym);
  const d = s.decision;
  const lines = [];
  lines.push(`Motor: ${ENGINE_PT[s.engine.status]} • modo ${MODE_PT[s.settings.executionMode]}`);
  if (d) lines.push(`Decisão: ${d.action} — ${d.reason}`);
  if (s.analysis) lines.push(`Tendência ${s.analysis.trend} • RSI ${s.analysis.rsi?.toFixed(1) ?? '—'} • vol ${s.analysis.volatilityPct?.toFixed(4) ?? '—'}%`);
  for (const r of s.engine.haltReasons.slice(0, 3)) lines.push(`⚠ ${r}`);
  if (!d && s.engine.status !== 'RUNNING') lines.push('Pressione INICIAR para o motor analisar as cotações.');
  floor.setHeadline(s.engine.haltReasons.length ? 'ENTRADAS BLOQUEADAS' : 'SUPERVISOR', lines);
}

// ---------------------------------------------------------------- estado + streaming
let state = null;
let streamAbort = null;
let streamOk = false;

async function stream() {
  let delay = 1000;
  while (token) {
    streamAbort = new AbortController();
    try {
      const res = await fetch(base() + '/api/stream', { headers: { Authorization: `Bearer ${token}` }, signal: streamAbort.signal });
      if (res.status === 401) return logout('Sessão inválida.');
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      streamOk = true; delay = 1000; renderStreamPill();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = 'message', data = '';
          for (const line of chunk.split('\n')) { if (line.startsWith('event: ')) ev = line.slice(7); else if (line.startsWith('data: ')) data += line.slice(6); }
          if (data) onEvent(ev, JSON.parse(data));
        }
      }
    } catch (e) {
      if (e.name === 'AbortError' && !token) return;
    }
    streamOk = false; renderStreamPill();
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 15000);
    try { render(await api('/api/state')); } catch { /* servidor fora do ar */ }
  }
}

function onEvent(type, data) {
  if (type === 'state') render(data);
  else if (type === 'tick' && state && data.symbol === state.market.symbol) {
    const last = state.market.ticks.at(-1);
    if (!last || data.epoch > last[0]) { state.market.ticks.push([data.epoch, data.quote]); if (state.market.ticks.length > 300) state.market.ticks.shift(); }
    state.market.lastTick = { ...state.market.lastTick, ...data, source: 'deriv:ticks' };
    renderMarket(state);
    if (floor) floor.setTicks(state.market.ticks, floor.chartTitle);
  } else if (type === 'audit' && state) {
    state.events.unshift(data); state.events.length = Math.min(state.events.length, 60);
    renderEvents(state.events);
  }
}

function renderStreamPill() {
  const p = $('#pill-stream');
  p.textContent = streamOk ? 'Painel ao vivo' : 'Painel reconectando';
  p.className = 'pill ' + (streamOk ? 'ok' : 'warn');
}

// ---------------------------------------------------------------- render
function render(s) {
  state = s;
  renderTop(s); renderAccount(s); renderPnl(s); renderMarket(s); renderDecision(s); renderRisk(s); renderAgents(s); renderTrades(s); renderEvents(s.events); renderControls(s); renderFloor(s); renderFocus();
}

function pill(node, text, cls) { node.textContent = text; node.className = 'pill ' + cls; }

function renderTop(s) {
  pill($('#pill-engine'), ENGINE_PT[s.engine.status] ?? s.engine.status, s.engine.status === 'RUNNING' ? (s.engine.haltReasons.length ? 'warn' : 'ok') : 'info');
  const pub = s.connection.public;
  pill($('#pill-public'), `Deriv público: ${pub.status === 'open' ? 'conectado' : pub.status}`, pub.status === 'open' ? 'ok' : 'bad');
  const acc = s.connection.account;
  if (!s.connection.credentialsConfigured) pill($('#pill-account'), 'Conta: sem credenciais', 'info');
  else pill($('#pill-account'), `Conta ${acc.mode ?? ''}: ${acc.status === 'open' ? 'conectada' : acc.status}`, acc.status === 'open' ? (acc.mode === 'real' ? 'bad' : 'ok') : 'bad');
  const b = $('#halt-banner');
  if (s.engine.haltReasons.length) {
    b.hidden = false;
    b.className = 'banner' + (s.engine.status === 'RUNNING' ? ' bad' : '');
    b.textContent = `Novas entradas bloqueadas pelo Supervisor: ${s.engine.haltReasons.join(' • ')}`;
  } else b.hidden = true;
}

function kv(dl, rows) {
  dl.replaceChildren();
  for (const [k, v] of rows) { dl.append(el('dt', '', k), el('dd', '', v)); }
}

function renderAccount(s) {
  const a = s.account;
  const v = $('#acc-balance'), badge = $('#acc-badge');
  if (!s.connection.credentialsConfigured) {
    v.textContent = 'Saldo indisponível'; v.className = 'value na';
    badge.textContent = 'SEM CONTA CONECTADA'; badge.className = 'badge';
    kv($('#acc-kv'), [['Motivo', 'DERIV_APP_ID / DERIV_PAT / DERIV_ACCOUNT_ID não configurados no servidor']]);
    $('#acc-src').textContent = 'Nenhum saldo é exibido sem confirmação da Deriv.';
    return;
  }
  if (!a) {
    v.textContent = 'Aguardando a Deriv'; v.className = 'value na';
    badge.textContent = 'NÃO CONFIRMADO'; badge.className = 'badge';
    kv($('#acc-kv'), [['Canal da conta', s.connection.account?.status ?? '—'], ['Último erro', s.connection.account?.lastError ?? '—']]);
    $('#acc-src').textContent = '';
    return;
  }
  v.textContent = `${fmt(a.balance)} ${a.currency}`; v.className = 'value';
  if (a.mode === 'demo') { badge.textContent = 'CONTA DEMO — DINHEIRO VIRTUAL'; badge.className = 'badge demo'; }
  else if (a.mode === 'real') { badge.textContent = 'CONTA REAL'; badge.className = 'badge real'; }
  else { badge.textContent = 'TIPO DE CONTA NÃO IDENTIFICADO'; badge.className = 'badge'; }
  kv($('#acc-kv'), [['Conta', a.loginid], ['Recebido', `${hhmmss(a.receivedAt)} (${ago(a.receivedAt)})`]]);
  $('#acc-src').textContent = 'Fonte: Deriv balance (assinatura em tempo real)';
}

function money(node, v, cur) {
  if (v === null || v === undefined) { node.textContent = '—'; node.className = 'value na'; return; }
  node.textContent = `${v > 0 ? '+' : ''}${fmt(v)}${cur ? ' ' + cur : ''}`;
  node.className = 'value ' + (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
}

function renderPnl(s) {
  const cur = s.account?.currency ?? '';
  const p = s.pnl;
  if (p.mode === 'signals' && p.settled === 0) {
    $('#pnl-real').textContent = 'Sem operações'; $('#pnl-real').className = 'value na';
  } else money($('#pnl-real'), p.realized, cur);
  money($('#pnl-unreal'), p.unrealized, cur);
  kv($('#pnl-kv'), [['Modo', MODE_PT[p.mode]], ['Liquidadas hoje', String(p.settled)], ['Ganhas / perdidas', `${p.wins} / ${p.losses}`], ['Contratos abertos', String(s.positions.length)]]);
  $('#pnl-src').textContent = `Fonte: ${p.source}. Dia ${p.day}.`;
}

function renderMarket(s) {
  const m = s.market, t = m.lastTick;
  $('#mk-symbol').textContent = m.symbol + (m.symbolInfo ? ` • ${m.symbolInfo.underlying_symbol_name}` : '');
  if (!t) {
    $('#mk-price').textContent = 'Sem cotação'; $('#mk-age').textContent = s.connection.public.status === 'open' ? 'aguardando o primeiro tick' : 'canal público desconectado';
  } else {
    $('#mk-price').textContent = Number(t.quote).toFixed(t.pipSize ?? 2);
    $('#mk-age').textContent = `tick ${new Date(t.epoch * 1000).toLocaleTimeString('pt-BR', { hour12: false })} • recebido ${ago(t.receivedAt)}`;
  }
  const info = m.symbolInfo;
  const status = info ? `mercado ${info.exchange_is_open ? 'aberto' : 'fechado'}${info.is_trading_suspended ? ', negociação suspensa' : ''}` : 'símbolo não confirmado em active_symbols';
  const ct = m.contracts.length ? m.contracts.map((c) => `${c.contract_type} ${c.expiry_type} ${c.min}–${c.max}`).join(' | ') : 'nenhum CALL/PUT consultado';
  $('#mk-src').textContent = `Fonte: Deriv ${t?.source === 'deriv:ticks' ? 'ticks (ao vivo)' : t ? 'ticks_history' : '—'} • ${status} • contracts_for (${m.contractsSource ?? '—'}): ${ct}`;
  drawChart($('#chart'), m.ticks);
}

function drawChart(cv, pts) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  if (!pts || pts.length < 2) { c.fillStyle = '#58708a'; c.font = '13px system-ui'; c.fillText('Sem cotações suficientes para o gráfico', 8, h / 2); return; }
  let lo = Infinity, hi = -Infinity; for (const [, q] of pts) { lo = Math.min(lo, q); hi = Math.max(hi, q); }
  if (hi === lo) { hi += 1; lo -= 1; }
  const X = (i) => (i / (pts.length - 1)) * (w - 4) + 2, Y = (q) => h - 14 - ((q - lo) / (hi - lo)) * (h - 24);
  c.strokeStyle = 'rgba(60,150,255,.15)'; c.lineWidth = 1;
  for (let g = 0; g < 4; g++) { const y = 6 + (g * (h - 20)) / 3; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  const grad = c.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, 'rgba(43,255,168,.25)'); grad.addColorStop(1, 'rgba(43,255,168,0)');
  c.beginPath(); c.moveTo(X(0), h); pts.forEach(([, q], i) => c.lineTo(X(i), Y(q))); c.lineTo(X(pts.length - 1), h); c.fillStyle = grad; c.fill();
  c.beginPath(); pts.forEach(([, q], i) => (i ? c.lineTo(X(i), Y(q)) : c.moveTo(X(i), Y(q)))); c.strokeStyle = '#2bffa8'; c.lineWidth = 1.6; c.stroke();
  c.fillStyle = '#58708a'; c.font = '10px system-ui';
  c.fillText(`máx ${hi}`, 4, 12); c.fillText(`mín ${lo}  •  ${pts.length} ticks`, 4, h - 2);
}

function renderDecision(s) {
  const d = s.decision, a = s.analysis;
  const act = $('#dc-action');
  if (!d) {
    act.textContent = s.engine.status === 'RUNNING' ? 'AGUARDANDO TICK' : 'MOTOR ' + ENGINE_PT[s.engine.status];
    act.className = 'action';
    $('#dc-reason').textContent = s.engine.status === 'RUNNING' ? 'A próxima cotação ao vivo dispara a análise.' : 'A análise roda apenas com o motor em execução.';
  } else {
    act.textContent = d.action; act.className = 'action ' + d.action;
    $('#dc-reason').textContent = d.reason;
  }
  const st = s.settings;
  kv($('#dc-kv'), [
    ['Estratégia', st.strategy === 'ema_cross' ? `Cruzamento EMA ${st.ema.fast}/${st.ema.slow}` : `Reversão RSI ${st.rsi.period} (${st.rsi.lower}/${st.rsi.upper})`],
    ['Contrato', `CALL/PUT ${st.contractDuration}${st.durationUnit} • stake ${st.stake}`],
    ['Execução', MODE_PT[st.executionMode]],
    ['Tendência', a?.trend ?? '—'],
    ['EMA rápida / lenta', a ? `${a.emaFast?.toFixed(4) ?? '—'} / ${a.emaSlow?.toFixed(4) ?? '—'}` : '—'],
    ['RSI', a?.rsi?.toFixed(2) ?? '—'],
    ['Volatilidade', a?.volatilityPct != null ? a.volatilityPct.toFixed(5) + '%' : '—'],
  ]);
  $('#dc-src').textContent = d ? `Decisão às ${hhmmss(d.at)} sobre o tick ${d.tickEpoch} • ${a?.samples ?? 0} cotações reais analisadas` : 'Sem decisão registrada nesta sessão.';
}

function bar(label, used, limit, fmtFn = (x) => fmt(x)) {
  const wrap = el('div', 'bar');
  const l = el('div', 'lbl'); l.append(el('span', '', label), el('span', 'mono', `${fmtFn(used)} / ${fmtFn(limit)}`));
  const tr = el('div', 'track'); const f = el('div', 'fill');
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  f.style.width = pct + '%';
  if (pct >= 100) f.classList.add('bad'); else if (pct >= 70) f.classList.add('warn');
  tr.append(f); wrap.append(l, tr);
  return wrap;
}

function renderRisk(s) {
  const r = s.settings.risk;
  const open = s.trades.filter((t) => ['PROPOSAL_REQUESTED', 'PROPOSAL_RECEIVED', 'BUY_SENT', 'OPEN', 'UNCONFIRMED'].includes(t.state));
  const exposure = open.reduce((x, t) => x + t.stake, 0);
  const loss = Math.max(0, -(s.pnl.realized || 0));
  const box = $('#risk-bars'); box.replaceChildren(
    bar('Perda do dia', loss, r.maxDailyLoss),
    bar('Exposição aberta', exposure, r.maxExposure),
    bar('Contratos abertos', open.length, r.maxOpenContracts, (x) => String(x)),
    bar('Stake vs limite por operação', s.settings.stake, r.maxStakePerTrade),
  );
  const ul = $('#risk-reasons'); ul.replaceChildren();
  const reasons = s.risk?.reasons ?? [`perdas seguidas pausam o motor após ${r.maxConsecutiveLosses}`, `intervalo mínimo entre entradas: ${r.cooldownSeconds} s`];
  for (const x of reasons) ul.append(el('li', '', x));
}

function renderAgents(s) {
  const ul = $('#agents'); ul.replaceChildren();
  for (const a of s.agents) {
    const li = el('li');
    const nm = el('div', 'nm'); const left = el('span'); left.append(el('span', `dot st-${a.status}`), document.createTextNode(a.name));
    nm.append(left, el('span', 'muted', STATUS_PT[a.status] ?? a.status));
    li.append(nm, el('div', 'dt', a.detail), el('div', 'dt', a.lastActivityAt ? `atividade ${ago(a.lastActivityAt)}` : 'sem atividade registrada'));
    li.addEventListener('click', () => { selectAgent(a.id); $('.stage').scrollIntoView({ behavior: 'smooth' }); });
    ul.append(li);
  }
}

function tradeRow(t) {
  const tr = el('tr');
  const res = t.state === 'SETTLED' ? `${t.profit > 0 ? '+' : ''}${fmt(t.profit)} (${t.result})` : t.error ? t.error.slice(0, 60) : '—';
  const cells = [`${t.id}`, hhmmss(t.created_at), t.account_mode.toUpperCase(), `${t.contract_type} ${t.symbol} ${t.duration}${t.duration_unit}${t.contract_id ? ' #' + t.contract_id : ''}`, `${fmt(t.stake)} ${t.currency}`, STATE_PT[t.state] ?? t.state, res];
  cells.forEach((c, i) => { const td = el('td', i === 6 && t.state === 'SETTLED' ? (t.profit > 0 ? 'pos' : 'neg') : '', c); tr.append(td); });
  return tr;
}
function renderTrades(s) {
  const tb = $('#trades tbody'); tb.replaceChildren();
  if (!s.trades.length) { const tr = el('tr'); const td = el('td', 'muted', 'Nenhuma operação registrada. Em modo SINAIS o sistema apenas analisa.'); td.colSpan = 7; tr.append(td); tb.append(tr); return; }
  for (const t of s.trades.slice(0, 12)) tb.append(tradeRow(t));
}

function eventItem(e) {
  const li = el('li', `lv-${e.level}`);
  li.append(el('span', 'ts mono', `${new Date(e.ts).toLocaleString('pt-BR', { hour12: false })}`), el('span', 'ag', e.agent), document.createTextNode(e.message));
  return li;
}
function renderEvents(events) {
  const ul = $('#events'); ul.replaceChildren(...events.slice(0, 40).map(eventItem));
}

function renderControls(s) {
  const st = s.engine.status;
  $('#btn-start').disabled = st === 'RUNNING';
  $('#btn-pause').disabled = st !== 'RUNNING';
  $('#btn-stop').disabled = st === 'STOPPED';
  const m = $('#btn-mode');
  const demo = s.settings.executionMode === 'demo';
  m.textContent = demo ? 'MODO DEMONSTRAÇÃO: ATIVO (ordens na conta demo Deriv)' : s.settings.executionMode === 'real' ? 'MODO REAL ATIVO — tocar volta para SINAIS' : 'MODO DEMONSTRAÇÃO: DESLIGADO (somente sinais)';
  m.classList.toggle('mode-demo', demo);
  const canDemo = s.connection.credentialsConfigured;
  m.disabled = !canDemo && !demo;
  m.title = canDemo ? '' : 'Configure as credenciais da Deriv no servidor para usar a conta demo';
}

// ---------------------------------------------------------------- controles
function msg(text, bad) { const p = $('#control-msg'); p.textContent = text; p.className = 'control-msg' + (bad ? ' error' : ''); }
async function control(cmd) {
  try { const r = await api(`/api/control/${cmd}`, { method: 'POST' }); msg(`Servidor confirmou: motor ${ENGINE_PT[r.status]}.`); render(await api('/api/state')); }
  catch (e) { msg(e.message, true); }
}
$('#btn-start').addEventListener('click', () => control('start'));
$('#btn-pause').addEventListener('click', () => control('pause'));
$('#btn-stop').addEventListener('click', () => {
  if (confirm('PARAR impede novas ordens. Contratos já abertos continuam na Deriv até a liquidação. Confirmar?')) control('stop');
});
$('#btn-mode').addEventListener('click', async () => {
  const cur = state.settings.executionMode;
  const next = cur === 'signals' ? 'demo' : 'signals';
  try { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ settings: { executionMode: next } }) }); msg(next === 'demo' ? 'Modo demonstração ativado: ordens irão para a conta DEMO da Deriv.' : 'Modo SINAIS: nenhuma ordem será enviada.'); render(await api('/api/state')); }
  catch (e) { msg(e.message, true); }
});

// ---------------------------------------------------------------- configurações
const dSet = $('#dlg-settings');
function getPath(o, p) { return p.split('.').reduce((x, k) => x?.[k], o); }
$('#btn-settings').addEventListener('click', async () => {
  const f = $('#settings-form');
  const sel = $('#set-symbol'); sel.replaceChildren();
  try {
    const sy = await api('/api/symbols');
    const list = [...sy.symbols].sort((a, b) => a.market.localeCompare(b.market) || a.underlying_symbol_name.localeCompare(b.underlying_symbol_name));
    for (const x of list) { const o = el('option', '', `${x.underlying_symbol_name} (${x.underlying_symbol}) — ${x.market}${x.exchange_is_open ? '' : ' • fechado'}`); o.value = x.underlying_symbol; sel.append(o); }
    if (!list.some((x) => x.underlying_symbol === state.settings.symbol)) { const o = el('option', '', `${state.settings.symbol} (não confirmado)`); o.value = state.settings.symbol; sel.prepend(o); }
  } catch { const o = el('option', '', state.settings.symbol); o.value = state.settings.symbol; sel.append(o); }
  for (const inp of f.querySelectorAll('[name]')) inp.value = String(getPath(state.settings, inp.name));
  $('#settings-error').textContent = '';
  $('#confirm-real').checked = false;
  $('#confirm-real-wrap').hidden = state.settings.executionMode !== 'real';
  dSet.showModal();
});
$('#settings-form [name="executionMode"]').addEventListener('change', (e) => { $('#confirm-real-wrap').hidden = e.target.value !== 'real'; });
$('#settings-save').addEventListener('click', async (e) => {
  e.preventDefault();
  const f = $('#settings-form');
  const out = { ema: {}, rsi: {}, risk: {} };
  for (const inp of f.querySelectorAll('[name]')) {
    const v = inp.type === 'number' ? Number(inp.value) : inp.value;
    const [a, b] = inp.name.split('.');
    if (b) out[a][b] = v; else out[a] = v;
  }
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ settings: out, confirmReal: $('#confirm-real').checked }) });
    dSet.close(); msg('Configurações salvas e validadas pelo servidor.');
    render(await api('/api/state'));
  } catch (err) { $('#settings-error').textContent = err.issues ? err.issues.join(' • ') : err.message; }
});

// ---------------------------------------------------------------- histórico
const dHist = $('#dlg-history');
let evBefore = null;
function table(head, rows) {
  const t = el('table'); const th = el('thead'); const tr = el('tr'); head.forEach((h) => tr.append(el('th', '', h))); th.append(tr); t.append(th);
  const tb = el('tbody'); rows.forEach((r) => tb.append(r)); t.append(tb); return t;
}
$('#btn-history').addEventListener('click', async () => {
  dHist.showModal();
  const [trades, decisions, events] = await Promise.all([api('/api/trades?limit=200'), api('/api/decisions?limit=200'), api('/api/events?limit=100')]);
  $('#h-trades').replaceChildren(trades.length ? table(['#', 'Criada', 'Conta', 'Contrato', 'Stake', 'Estado', 'Resultado'], trades.map(tradeRow)) : el('p', 'muted', 'Nenhuma operação.'));
  $('#h-decisions').replaceChildren(decisions.length ? table(['Hora', 'Símbolo', 'Estratégia', 'Tick', 'Ação', 'Motivo', 'Veredito'], decisions.map((d) => {
    const tr = el('tr'); [new Date(d.ts).toLocaleString('pt-BR', { hour12: false }), d.symbol, d.strategy, d.tick_epoch, d.action, d.reason, `${d.verdict}${d.verdict_reason ? ': ' + d.verdict_reason : ''}`].forEach((c) => tr.append(el('td', '', String(c)))); return tr;
  })) : el('p', 'muted', 'Nenhuma decisão com sinal registrada (AGUARDAR não é gravado no banco).'));
  $('#h-events-list').replaceChildren(...events.map(eventItem));
  evBefore = events.at(-1)?.id ?? null;
});
$('#h-more').addEventListener('click', async () => {
  if (!evBefore) return;
  const more = await api(`/api/events?limit=100&before=${evBefore}`);
  $('#h-events-list').append(...more.map(eventItem));
  evBefore = more.at(-1)?.id ?? null;
});
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  for (const id of ['h-trades', 'h-decisions', 'h-events']) $('#' + id).hidden = id !== b.dataset.tab;
}));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------------------------------------------------------------- diagnóstico
const dDiag = $('#dlg-diag');
$('#btn-diag').addEventListener('click', async () => {
  dDiag.showModal();
  const body = $('#diag-body'); body.replaceChildren(el('p', 'muted', 'Executando verificações no servidor…'));
  try {
    const d = await api('/api/diagnostics');
    const ul = el('ul', 'checks');
    for (const c of d.checks) { const li = el('li', c.ok ? 'ok' : 'bad'); li.append(el('b', '', `${c.ok ? '✔' : '✖'} ${c.name}`), el('span', 'muted', c.detail)); ul.append(li); }
    const socks = el('pre', 'mono src', JSON.stringify(d.sockets, null, 2));
    body.replaceChildren(el('p', 'src', `Verificado às ${hhmmss(d.at)}`), ul, el('h3', '', 'Conexões'), socks);
  } catch (e) { body.replaceChildren(el('p', 'error', e.message)); }
});
$('#btn-ack').addEventListener('click', async () => { try { const r = await api('/api/control/ack', { method: 'POST' }); msg(r.haltReasons.length ? `Travas restantes: ${r.haltReasons.join('; ')}` : 'Nenhuma trava ativa.'); dDiag.close(); } catch (e) { msg(e.message, true); } });
$('#btn-logout').addEventListener('click', () => { dDiag.close(); logout(''); });

// ---------------------------------------------------------------- boot
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('pt-BR', { hour12: false }); if (state) { renderMarket(state); } }, 1000);
window.addEventListener('resize', () => { if (state) drawChart($('#chart'), state.market.ticks); });

function boot(initial) {
  $('#login').hidden = true; $('#app').hidden = false;
  if (!floor) setupFloor();
  render(initial);
  void stream();
}

(async () => {
  const same = await sameOriginEngine();
  if (same) server = '';
  $('#login-server-wrap').hidden = same;
  $('#login-server').value = server;
  $('#where').textContent = same ? '' : (server ? `Motor: ${server}` : '');
  if (!token || (!same && !server)) { $('#login').hidden = false; return; }
  try { boot(await api('/api/state')); } catch { if (token) { $('#login').hidden = false; $('#login-error').textContent = 'Servidor indisponível no momento.'; } }
})();
