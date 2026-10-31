import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emaSeries, rsiSeries, volatilityPct, slopePct } from '../src/strategies/indicators.ts';
import { evaluate, type Analysis } from '../src/strategies/engine.ts';
import { DEFAULT_SETTINGS, mergeAndValidate, ValidationError, type Settings } from '../src/settings.ts';
import { contractOffered, parseDuration, SignalValidator } from '../src/agents/validator.ts';
import { checkRisk, type RiskContext } from '../src/agents/risk.ts';
import { checkSettlement, matchStatement } from '../src/agents/portfolio.ts';
import { normalizeTick } from '../src/agents/marketData.ts';
import { analyze } from '../src/agents/analyzer.ts';
import { modeFromWsUrl, pickDemoAccount } from '../src/deriv/auth.ts';
import { redact, registerSecret } from '../src/logger.ts';
import { parseOrigins } from '../src/config.ts';
import type { TradeRow } from '../src/db.ts';

const S = (patch: Partial<Settings> = {}): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), ...patch });

// --------------------------------------------------------------- indicadores
test('EMA: semente SMA e recursão corretas', () => {
  const e = emaSeries([1, 2, 3, 4, 5], 3);
  assert.equal(e.length, 3);
  assert.equal(e[0], 2); // SMA(1,2,3)
  assert.equal(e[1], 3); // 4*0.5 + 2*0.5
  assert.equal(e[2], 4);
  assert.deepEqual(emaSeries([1, 2], 3), []);
});

test('RSI: 100 em alta contínua, 0 em queda contínua, 50 sem variação', () => {
  assert.equal(rsiSeries([1, 2, 3, 4, 5, 6], 3).at(-1), 100);
  assert.equal(rsiSeries([6, 5, 4, 3, 2, 1], 3).at(-1), 0);
  assert.equal(rsiSeries([5, 5, 5, 5, 5], 3).at(-1), 50);
});

test('RSI: valor de referência de Wilder', () => {
  // gains: 1,0,1 ; losses: 0,1,0 → avgG=2/3, avgL=1/3 → RS=2 → RSI=66.67
  const r = rsiSeries([10, 11, 10, 11], 3);
  assert.equal(r.length, 1);
  assert.ok(Math.abs(r[0]! - 66.6667) < 0.001);
});

test('volatilidade e inclinação', () => {
  assert.equal(volatilityPct([1, 1, 1, 1], 3), 0);
  assert.equal(volatilityPct([1, 2], 3), null);
  assert.ok(slopePct([1, 2, 3, 4], 4)! > 0);
  assert.ok(slopePct([4, 3, 2, 1], 4)! < 0);
});

// --------------------------------------------------------------- estratégia
const base: Analysis = { symbol: 'R_100', tickEpoch: 1, price: 100, samples: 100, emaFast: 1, emaSlow: 1, prevEmaFast: 1, prevEmaSlow: 1, rsi: 50, prevRsi: 50, volatilityPct: 0.01, trendSlopePct: 0, trend: 'lateral' };

test('ema_cross: CALL no cruzamento para cima, PUT para baixo, AGUARDAR sem cruzamento', () => {
  const s = S();
  assert.equal(evaluate(s, { ...base, prevEmaFast: 9, prevEmaSlow: 10, emaFast: 11, emaSlow: 10 }).action, 'CALL');
  assert.equal(evaluate(s, { ...base, prevEmaFast: 11, prevEmaSlow: 10, emaFast: 9, emaSlow: 10 }).action, 'PUT');
  const w = evaluate(s, { ...base, prevEmaFast: 11, prevEmaSlow: 10, emaFast: 12, emaSlow: 10 });
  assert.equal(w.action, 'AGUARDAR');
  assert.match(w.reason, /sem cruzamento/);
});

test('estratégia retorna AGUARDAR com dados insuficientes e registra o motivo', () => {
  const d = evaluate(S(), { ...base, samples: 5 });
  assert.equal(d.action, 'AGUARDAR');
  assert.match(d.reason, /dados insuficientes \(5\/22/);
});

test('rsi_reversion: gatilhos de saída de sobrevenda/sobrecompra', () => {
  const s = S({ strategy: 'rsi_reversion' });
  assert.equal(evaluate(s, { ...base, prevRsi: 25, rsi: 31 }).action, 'CALL');
  assert.equal(evaluate(s, { ...base, prevRsi: 75, rsi: 69 }).action, 'PUT');
  assert.equal(evaluate(s, { ...base, prevRsi: 25, rsi: 28 }).action, 'AGUARDAR');
});

test('filtro de volatilidade bloqueia entradas fora da faixa', () => {
  const s = S({ minVolatilityPct: 0.05, maxVolatilityPct: 1 });
  const d = evaluate(s, { ...base, prevEmaFast: 9, prevEmaSlow: 10, emaFast: 11, emaSlow: 10, volatilityPct: 0.01 });
  assert.equal(d.action, 'AGUARDAR');
  assert.match(d.reason, /abaixo do mínimo/);
});

test('analyze() calcula indicadores a partir das cotações', () => {
  const ticks = Array.from({ length: 60 }, (_, i) => ({ symbol: 'R_100', epoch: i + 1, quote: 100 + i * 0.1, pipSize: 2, receivedAt: 0, source: 'deriv:ticks' as const }));
  const a = analyze(ticks, S());
  assert.equal(a.samples, 60);
  assert.equal(a.trend, 'alta');
  assert.ok(a.emaFast! > a.emaSlow!);
  assert.equal(a.rsi, 100);
});

// --------------------------------------------------------------- configurações
test('configurações: valida limites e rejeita campos desconhecidos', () => {
  assert.throws(() => mergeAndValidate(S(), { stake: 50 }), ValidationError); // > maxStakePerTrade
  assert.throws(() => mergeAndValidate(S(), { foo: 1 }), /desconhecidos/);
  assert.throws(() => mergeAndValidate(S(), { ema: { fast: 30, slow: 20 } }), /ema.fast/);
  assert.throws(() => mergeAndValidate(S(), { symbol: 'R 100;' }), /symbol/);
  const ok = mergeAndValidate(S(), { stake: 2, risk: { maxStakePerTrade: 3 } });
  assert.equal(ok.stake, 2);
  assert.equal(ok.risk.maxStakePerTrade, 3);
  assert.equal(ok.risk.maxDailyLoss, DEFAULT_SETTINGS.risk.maxDailyLoss);
});

// --------------------------------------------------------------- validador
const contracts = [
  { barriers: 0, contract_category: 'callput', contract_type: 'CALL', expiry_type: 'tick', market: 'synthetic_index', max_contract_duration: '10t', min_contract_duration: '1t', sentiment: 'up', submarket: 'random_index', underlying_symbol: 'R_100' },
  { barriers: 0, contract_category: 'callput', contract_type: 'CALL', expiry_type: 'intraday', market: 'synthetic_index', max_contract_duration: '1d', min_contract_duration: '15s', sentiment: 'up', submarket: 'random_index', underlying_symbol: 'R_100' },
];
const info = { exchange_is_open: 1 as const, is_trading_suspended: 0 as const, market: 'synthetic_index', pip_size: 0.01, subgroup: '', submarket: '', trade_count: 0, underlying_symbol: 'R_100', underlying_symbol_name: 'Vol 100', underlying_symbol_type: '' };

test('parseDuration e contractOffered respeitam contracts_for', () => {
  assert.deepEqual(parseDuration('5t'), { value: 5, unit: 't' });
  assert.deepEqual(parseDuration('10'), { value: 10, unit: null });
  assert.equal(parseDuration('abc'), null);
  assert.equal(contractOffered(contracts, 'CALL', 5, 't').ok, true);
  assert.equal(contractOffered(contracts, 'CALL', 11, 't').ok, false);
  assert.equal(contractOffered(contracts, 'CALL', 1, 'm').ok, true);
  assert.equal(contractOffered(contracts, 'CALL', 10, 's').ok, false);
  assert.equal(contractOffered(contracts, 'PUT', 5, 't').ok, false);
});

test('validador: bloqueia duplicata, cotação velha, mercado fechado e histórico', () => {
  const v = new SignalValidator();
  const now = 1_000_000;
  const tick = { symbol: 'R_100', epoch: 42, quote: 100, pipSize: 2, receivedAt: now - 1000, source: 'deriv:ticks' as const };
  const d = { action: 'CALL' as const, reason: 'x', indicators: {} };
  const s = S();
  assert.equal(v.validate(d, tick, s, info, contracts, now).ok, true);
  const dup = v.validate(d, tick, s, info, contracts, now);
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /duplicado/);
  assert.match(v.validate(d, { ...tick, epoch: 43, receivedAt: now - 60_000 }, s, info, contracts, now).reason, /cotação com/);
  assert.match(v.validate(d, { ...tick, epoch: 44 }, s, { ...info, exchange_is_open: 0 }, contracts, now).reason, /mercado fechado/);
  assert.match(v.validate(d, { ...tick, epoch: 45, source: 'deriv:ticks_history' }, s, info, contracts, now).reason, /histórico/);
  assert.match(v.validate({ ...d, action: 'AGUARDAR' }, { ...tick, epoch: 46 }, s, info, contracts, now).reason, /AGUARDAR/);
});

test('normalizeTick rejeita dados inválidos', () => {
  assert.equal(normalizeTick({ quote: -1, epoch: 1, symbol: 'R_100' }, 'R_100', 0, 'deriv:ticks'), null);
  assert.equal(normalizeTick({ quote: 1, epoch: 1.5, symbol: 'R_100' }, 'R_100', 0, 'deriv:ticks'), null);
  assert.equal(normalizeTick({ quote: 1, epoch: 1, symbol: 'R_50' }, 'R_100', 0, 'deriv:ticks'), null);
  assert.equal(normalizeTick(null, 'R_100', 0, 'deriv:ticks'), null);
  assert.ok(normalizeTick({ quote: 1, epoch: 1, symbol: 'R_100', pip_size: 2 }, 'R_100', 0, 'deriv:ticks'));
});

// --------------------------------------------------------------- risco
const ctx = (p: Partial<RiskContext> = {}): RiskContext => ({
  executionMode: 'demo', allowRealTrading: false, accountMode: 'demo', balance: 100, balanceAgeMs: 1000, realizedToday: 0,
  openCount: 0, openExposure: 0, unconfirmedCount: 0, consecutiveLosses: 0, lastEntryAt: null, now: 1_000_000, ...p,
});

test('risco: aprova quando tudo está dentro dos limites', () => {
  assert.equal(checkRisk(S({ executionMode: 'demo' }), ctx()).ok, true);
});

test('risco: cada limite bloqueia individualmente', () => {
  const s = S({ executionMode: 'demo' });
  const cases: [Partial<RiskContext>, RegExp][] = [
    [{ realizedToday: -20 }, /perda diária atingido/],
    [{ realizedToday: -19.5 }, /pior cenário/],
    [{ openCount: 1 }, /contrato\(s\) aberto/],
    [{ openExposure: 4.5 }, /exposição/],
    [{ unconfirmedCount: 1 }, /sem confirmação/],
    [{ consecutiveLosses: 3 }, /perdas seguidas/],
    [{ lastEntryAt: 1_000_000 - 5000 }, /intervalo mínimo/],
    [{ balance: null }, /saldo não confirmado/],
    [{ balance: 0.5 }, /insuficiente/],
    [{ accountMode: 'real' }, /conta conectada é real/],
    [{ accountMode: null }, /não conectada/],
  ];
  for (const [p, re] of cases) {
    const v = checkRisk(s, ctx(p));
    assert.equal(v.ok, false, `deveria bloquear: ${re}`);
    assert.ok(v.blocking.some((b) => re.test(b)), `${re} em ${v.blocking.join(' | ')}`);
  }
});

test('risco: modo real exige ALLOW_REAL_TRADING; modo sinais nunca executa', () => {
  assert.ok(checkRisk(S({ executionMode: 'real' }), ctx({ executionMode: 'real', accountMode: 'real' })).blocking.some((b) => /ALLOW_REAL_TRADING/.test(b)));
  assert.equal(checkRisk(S({ executionMode: 'signals' }), ctx({ executionMode: 'signals' })).ok, false);
});

test('risco: stake nunca é aumentado após perdas (sem martingale)', () => {
  const s = S({ executionMode: 'demo' });
  const v = checkRisk(s, ctx({ consecutiveLosses: 2, realizedToday: -2 }));
  assert.equal(v.ok, true);
  assert.equal(s.stake, DEFAULT_SETTINGS.stake);
});

// --------------------------------------------------------------- liquidação
test('checkSettlement: só liquida com is_sold=1 e valores consistentes', () => {
  assert.equal(checkSettlement({ contract_id: 1, status: 'open', is_sold: 0, profit: '0.3', buy_price: '1' }).kind, 'open');
  const ok = checkSettlement({ contract_id: 1, status: 'won', is_sold: 1, profit: '0.95', buy_price: '1.00', sell_price: '1.95' });
  assert.equal(ok.kind, 'settled');
  if (ok.kind === 'settled') assert.equal(ok.profit, 0.95);
  assert.equal(checkSettlement({ contract_id: 1, status: 'won', is_sold: 1, profit: '5', buy_price: '1', sell_price: '1.95' }).kind, 'inconsistent');
  assert.equal(checkSettlement({ contract_id: 1, status: 'won', is_sold: 1, profit: '0.95', buy_price: '1', sell_price: null }).kind, 'inconsistent');
  assert.equal(checkSettlement({ contract_id: 1, status: 'open', is_sold: 1, profit: '0', buy_price: '1', sell_price: '1' }).kind, 'inconsistent');
});

test('matchStatement encontra apenas a compra compatível', () => {
  const created = new Date(1_700_000_000_000).toISOString();
  const trade = { created_at: created, ask_price: 1, stake: 1, contract_type: 'CALL', symbol: 'R_100' } as TradeRow;
  const base = { action_type: 'buy', amount: -1, app_id: '12345', balance_after: 0, contract_id: 7, transaction_id: 70, transaction_time: 1_700_000_002, shortcode: 'CALL_R_100_1.95_1700000002_5T_S0P_0' };
  assert.equal(matchStatement(trade, [base], '12345', new Set()).length, 1);
  assert.equal(matchStatement(trade, [{ ...base, amount: -2 }], '12345', new Set()).length, 0);
  assert.equal(matchStatement(trade, [{ ...base, app_id: '999' }], '12345', new Set()).length, 0);
  assert.equal(matchStatement(trade, [base], '12345', new Set([7])).length, 0);
  assert.equal(matchStatement(trade, [{ ...base, shortcode: 'PUT_R_100_x' }], '12345', new Set()).length, 0);
  assert.equal(matchStatement(trade, [{ ...base, transaction_time: 1_700_000_500 }], '12345', new Set()).length, 0);
});

// --------------------------------------------------------------- segurança
test('modo da conta vem da URL do OTP', () => {
  assert.equal(modeFromWsUrl('wss://api.derivws.com/trading/v1/options/ws/demo?otp=a'), 'demo');
  assert.equal(modeFromWsUrl('wss://api.derivws.com/trading/v1/options/ws/real?otp=a'), 'real');
  assert.equal(modeFromWsUrl('wss://api.derivws.com/x'), 'desconhecido');
});

test('logger mascara segredos, OTP e Bearer', () => {
  registerSecret('super-secret-token-123');
  const out = redact('t=super-secret-token-123 url=wss://h/ws/demo?otp=abc123 Authorization: Bearer xyz.987');
  assert.ok(!out.includes('super-secret-token-123'));
  assert.ok(!out.includes('abc123'));
  assert.ok(!out.includes('xyz.987'));
});

test('ALLOWED_ORIGINS: normaliza e exige https', () => {
  assert.deepEqual(parseOrigins('https://a.pages.dev/, https://b.pages.dev/x'), ['https://a.pages.dev', 'https://b.pages.dev']);
  assert.deepEqual(parseOrigins(null), []);
  assert.throws(() => parseOrigins('http://a.pages.dev'), /https/);
});

test('contractOffered aceita barriers "0" e explica quando só há contratos com barreira', () => {
  const base = { contract_category: 'callput', contract_type: 'PUT', expiry_type: 'tick', market: 'synthetic_index', max_contract_duration: '10t', min_contract_duration: '1t', sentiment: 'down', submarket: 'random_index', underlying_symbol: 'R_100' };
  assert.equal(contractOffered([{ ...base, barriers: '0' as unknown as number }], 'PUT', 5, 't').ok, true);
  const r = contractOffered([{ ...base, barriers: 1 }], 'PUT', 5, 't');
  assert.equal(r.ok, false);
  assert.match(r.reason, /barriers=1/);
});

test('pickDemoAccount escolhe só conta demo ativa, nunca real', () => {
  const real = { account_id: 'CR1', account_type: 'real', status: 'active', currency: 'USD' };
  const demoOff = { account_id: 'DOT1', account_type: 'demo', status: 'disabled', currency: 'USD' };
  const demo = { account_id: 'DOT2', account_type: 'demo', status: 'active', currency: 'USD' };
  assert.equal(pickDemoAccount([real, demoOff, demo])?.account_id, 'DOT2');
  assert.equal(pickDemoAccount([real]), null);
});
