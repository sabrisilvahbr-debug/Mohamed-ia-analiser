import type { Settings } from '../settings.ts';

export type Action = 'CALL' | 'PUT' | 'AGUARDAR';

export interface Analysis {
  symbol: string;
  tickEpoch: number;
  price: number;
  samples: number;
  emaFast: number | null;
  emaSlow: number | null;
  prevEmaFast: number | null;
  prevEmaSlow: number | null;
  rsi: number | null;
  prevRsi: number | null;
  volatilityPct: number | null;
  trendSlopePct: number | null;
  trend: 'alta' | 'baixa' | 'lateral' | 'indefinida';
}

export interface Decision {
  action: Action;
  reason: string;
  indicators: Record<string, number | string | null>;
}

/** Amostras mínimas para cada estratégia produzir uma decisão. */
export function requiredSamples(s: Settings): number {
  return s.strategy === 'ema_cross' ? s.ema.slow + 1 : s.rsi.period + 2;
}

function round(v: number | null, d = 6): number | null { return v === null ? null : Number(v.toFixed(d)); }

/**
 * Agente 3 — Strategy Engine. Função pura: mesma análise → mesma decisão.
 * Retorna AGUARDAR sempre que não houver condição de entrada clara.
 * Não há martingale nem ajuste de stake com base em perdas anteriores.
 */
export function evaluate(s: Settings, a: Analysis): Decision {
  const indicators = {
    preco: a.price,
    ema_rapida: round(a.emaFast),
    ema_lenta: round(a.emaSlow),
    rsi: round(a.rsi, 2),
    volatilidade_pct: round(a.volatilityPct, 5),
    tendencia: a.trend,
    amostras: a.samples,
  };
  const need = requiredSamples(s);
  if (a.samples < need) return { action: 'AGUARDAR', reason: `dados insuficientes (${a.samples}/${need} cotações)`, indicators };

  if (s.maxVolatilityPct > 0 || s.minVolatilityPct > 0) {
    if (a.volatilityPct === null) return { action: 'AGUARDAR', reason: 'volatilidade ainda não calculável', indicators };
    if (s.minVolatilityPct > 0 && a.volatilityPct < s.minVolatilityPct) return { action: 'AGUARDAR', reason: `volatilidade ${a.volatilityPct.toFixed(4)}% abaixo do mínimo ${s.minVolatilityPct}%`, indicators };
    if (s.maxVolatilityPct > 0 && a.volatilityPct > s.maxVolatilityPct) return { action: 'AGUARDAR', reason: `volatilidade ${a.volatilityPct.toFixed(4)}% acima do máximo ${s.maxVolatilityPct}%`, indicators };
  }

  if (s.strategy === 'ema_cross') {
    const { emaFast: f, emaSlow: sl, prevEmaFast: pf, prevEmaSlow: ps } = a;
    if (f === null || sl === null || pf === null || ps === null) return { action: 'AGUARDAR', reason: 'EMAs indisponíveis', indicators };
    if (pf <= ps && f > sl) return { action: 'CALL', reason: `EMA${s.ema.fast} cruzou acima da EMA${s.ema.slow}`, indicators };
    if (pf >= ps && f < sl) return { action: 'PUT', reason: `EMA${s.ema.fast} cruzou abaixo da EMA${s.ema.slow}`, indicators };
    return { action: 'AGUARDAR', reason: `sem cruzamento (EMA${s.ema.fast} ${f > sl ? 'acima' : 'abaixo'} da EMA${s.ema.slow})`, indicators };
  }

  // rsi_reversion
  const { rsi: r, prevRsi: pr } = a;
  if (r === null || pr === null) return { action: 'AGUARDAR', reason: 'RSI indisponível', indicators };
  if (pr < s.rsi.lower && r >= s.rsi.lower) return { action: 'CALL', reason: `RSI saiu da sobrevenda (${pr.toFixed(1)} → ${r.toFixed(1)})`, indicators };
  if (pr > s.rsi.upper && r <= s.rsi.upper) return { action: 'PUT', reason: `RSI saiu da sobrecompra (${pr.toFixed(1)} → ${r.toFixed(1)})`, indicators };
  return { action: 'AGUARDAR', reason: `RSI ${r.toFixed(1)} sem gatilho (${s.rsi.lower}/${s.rsi.upper})`, indicators };
}
