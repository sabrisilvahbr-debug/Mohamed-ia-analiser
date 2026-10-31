/**
 * Backtest com DADOS REAIS da Deriv (ticks_history do canal público).
 * Uso:  npm run backtest -- R_100 5000 0.95
 *       (símbolo, quantidade de ticks até 5000, retorno líquido por vitória: payout/stake − 1)
 *
 * Limitações declaradas:
 *  - aproxima o contrato Rise/Fall (CALL/PUT) de N ticks comparando o tick de entrada (próximo tick
 *    após o sinal, simulando a latência de execução) com o tick N posições depois;
 *  - empate conta como perda (na Deriv, Rise/Fall exige preço estritamente maior/menor);
 *  - o retorno por vitória deve ser informado pelo usuário a partir de uma proposta real (payout/ask_price),
 *    pois varia por símbolo, duração e momento;
 *  - resultado passado não garante resultado futuro.
 */
import { loadDotEnv, readConfig } from '../backend/src/config.ts';
import { DerivSocket } from '../backend/src/deriv/client.ts';
import type { TicksHistoryResponse } from '../backend/src/deriv/protocol.ts';
import { DEFAULT_SETTINGS } from '../backend/src/settings.ts';
import { analyze } from '../backend/src/agents/analyzer.ts';
import { evaluate } from '../backend/src/strategies/engine.ts';
import type { NormalizedTick } from '../backend/src/agents/marketData.ts';

loadDotEnv();
process.env.LOG_SILENT = '1';
const [symbol = 'R_100', countArg = '5000', retArg = ''] = process.argv.slice(2);
const count = Math.min(5000, Math.max(100, Number(countArg)));
const winReturn = retArg ? Number(retArg) : null;
const cfg = readConfig();

const sock = new DerivSocket({ name: 'backtest', urlProvider: async () => cfg.deriv.publicWs });
sock.start();
await new Promise<void>((resolve, reject) => { sock.once('open', () => resolve()); setTimeout(() => reject(new Error('sem conexão com a Deriv em 20 s')), 20_000).unref(); });
const h = await sock.send<TicksHistoryResponse>({ ticks_history: symbol, end: 'latest', count, style: 'ticks' }, 30_000);
sock.stop();
const prices = h.history?.prices ?? [], times = h.history?.times ?? [];
const ticks: NormalizedTick[] = prices.map((q, i) => ({ symbol, epoch: times[i]!, quote: q, pipSize: h.pip_size ?? 2, receivedAt: 0, source: 'deriv:ticks' }));
console.log(`Dados reais: ${ticks.length} ticks de ${symbol} (${new Date(times[0]! * 1000).toISOString()} → ${new Date(times.at(-1)! * 1000).toISOString()})`);

for (const strategy of ['ema_cross', 'rsi_reversion'] as const) {
  const s = { ...structuredClone(DEFAULT_SETTINGS), symbol, strategy };
  const N = s.contractDuration;
  let wins = 0, losses = 0, signals = 0;
  for (let i = 30; i < ticks.length - N - 1; i++) {
    const d = evaluate(s, analyze(ticks.slice(Math.max(0, i - 500), i + 1), s));
    if (d.action === 'AGUARDAR') continue;
    signals++;
    const entry = ticks[i + 1]!.quote, exit = ticks[i + 1 + N]!.quote;
    const win = d.action === 'CALL' ? exit > entry : exit < entry;
    if (win) wins++; else losses++;
  }
  const rate = signals ? wins / signals : 0;
  const breakeven = winReturn ? 1 / (1 + winReturn) : null;
  const ev = winReturn !== null ? rate * winReturn - (1 - rate) : null;
  console.log(`\n[${strategy}] sinais ${signals} • acertos ${wins} • erros ${losses} • taxa ${(rate * 100).toFixed(2)}%`);
  if (breakeven !== null) console.log(`  taxa mínima para empatar com retorno ${winReturn}: ${(breakeven * 100).toFixed(2)}% • resultado esperado por unidade apostada: ${ev!.toFixed(4)}`);
  else console.log('  informe o retorno por vitória (3º argumento) para calcular o ponto de equilíbrio');
}
process.exit(0);
