// GERADO por scripts/build-frontend-lib.ts a partir de backend/src/strategies/indicators.ts — não editar.
/** Indicadores técnicos determinísticos (funções puras, testadas em backend/test). */

/** Média móvel exponencial. Semente = média simples dos primeiros `period` valores. */
export function emaSeries(values                   , period        )           {
  if (period < 1 || values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i] ;
  prev /= period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i]  * k + prev * (1 - k);
    out.push(prev);
  }
  return out; // out[j] corresponde a values[j + period - 1]
}

/** RSI de Wilder. Retorna série alinhada ao final de `values` (out[j] ↔ values[j + period]). */
export function rsiSeries(values                   , period        )           {
  if (values.length <= period) return [];
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]  - values[i - 1] ;
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  const rsi = (g        , l        ) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  const out = [rsi(avgG, avgL)];
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]  - values[i - 1] ;
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out.push(rsi(avgG, avgL));
  }
  return out;
}

/** Desvio-padrão amostral dos retornos logarítmicos das últimas `window` variações, em %. */
export function volatilityPct(values                   , window        )                {
  if (values.length < window + 1) return null;
  const rets           = [];
  for (let i = values.length - window; i < values.length; i++) {
    const a = values[i - 1] , b = values[i] ;
    if (a <= 0 || b <= 0) return null;
    rets.push(Math.log(b / a));
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const v = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * 100;
}

/** Inclinação (regressão linear) normalizada pelo último valor, em % por amostra. */
export function slopePct(values                   , window        )                {
  if (values.length < window || window < 2) return null;
  const ys = values.slice(-window);
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (ys[i]  - my); den += (i - mx) ** 2; }
  const last = ys[n - 1] ;
  return last === 0 ? null : (num / den / last) * 100;
}
