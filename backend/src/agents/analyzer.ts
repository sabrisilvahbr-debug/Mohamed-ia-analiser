import type { Settings } from '../settings.ts';
import type { Analysis } from '../strategies/engine.ts';
import { emaSeries, rsiSeries, slopePct, volatilityPct } from '../strategies/indicators.ts';
import type { NormalizedTick } from './marketData.ts';

const VOL_WINDOW = 50;
const TREND_WINDOW = 30;

/** Agente 2 — Market Analyzer: transforma cotações reais em indicadores. Função pura. */
export function analyze(ticks: readonly NormalizedTick[], s: Settings): Analysis {
  const last = ticks[ticks.length - 1];
  if (!last) throw new Error('analyze() sem cotações');
  const prices = ticks.map((t) => t.quote);
  const ef = emaSeries(prices, s.ema.fast);
  const es = emaSeries(prices, s.ema.slow);
  const rs = rsiSeries(prices, s.rsi.period);
  const slope = slopePct(es.length >= TREND_WINDOW ? es : prices, Math.min(TREND_WINDOW, Math.max(2, es.length || prices.length)));
  const vol = volatilityPct(prices, Math.min(VOL_WINDOW, prices.length - 1));
  let trend: Analysis['trend'] = 'indefinida';
  if (slope !== null && vol !== null && prices.length > 10) {
    // inclinação relevante = maior que 10% da volatilidade por amostra
    const threshold = vol * 0.1;
    trend = slope > threshold ? 'alta' : slope < -threshold ? 'baixa' : 'lateral';
  }
  return {
    symbol: last.symbol,
    tickEpoch: last.epoch,
    price: last.quote,
    samples: prices.length,
    emaFast: ef.at(-1) ?? null,
    emaSlow: es.at(-1) ?? null,
    prevEmaFast: ef.length >= 2 ? ef.at(-2)! : null,
    prevEmaSlow: es.length >= 2 ? es.at(-2)! : null,
    rsi: rs.at(-1) ?? null,
    prevRsi: rs.length >= 2 ? rs.at(-2)! : null,
    volatilityPct: prices.length > 2 ? vol : null,
    trendSlopePct: slope,
    trend,
  };
}
