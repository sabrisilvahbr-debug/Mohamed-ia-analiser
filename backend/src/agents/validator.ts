import type { ActiveSymbol, ContractAvailable } from '../deriv/protocol.ts';
import type { Settings } from '../settings.ts';
import type { Decision } from '../strategies/engine.ts';
import type { NormalizedTick } from './marketData.ts';

export interface ValidationResult { ok: boolean; reason: string; signalKey: string }

/** "5", "5t", "15s", "1m", "1d" → { value, unit } */
export function parseDuration(s: string): { value: number; unit: string | null } | null {
  const m = /^(\d+)\s*([tsmhd])?$/.exec(s.trim());
  if (!m) return null;
  return { value: Number(m[1]), unit: m[2] ?? null };
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Verifica se o contrato (CALL/PUT, duração) consta em contracts_for. */
export function contractOffered(contracts: readonly ContractAvailable[], contractType: string, duration: number, unit: Settings['durationUnit']): { ok: boolean; reason: string } {
  const sameType = contracts.filter((c) => c.contract_type === contractType);
  if (!sameType.length) return { ok: false, reason: `${contractType} não consta em contracts_for` };
  const expiry = unit === 't' ? 'tick' : 'intraday';
  const withExpiry = sameType.filter((c) => c.expiry_type === expiry);
  if (!withExpiry.length) return { ok: false, reason: `${contractType} sem expiração "${expiry}" em contracts_for` };
  // Rise/Fall = sem barreira. Aceita 0 numérico ou "0" (robustez ao formato recebido).
  const candidates = withExpiry.filter((c) => Number(c.barriers) === 0);
  if (!candidates.length) {
    const seen = [...new Set(withExpiry.map((c) => `${c.contract_category}/barriers=${JSON.stringify(c.barriers)}`))].join(', ');
    return { ok: false, reason: `${contractType} "${expiry}" só oferecido com barreira (${seen}) — o sistema opera apenas Rise/Fall sem barreira` };
  }
  for (const c of candidates) {
    const min = parseDuration(c.min_contract_duration);
    const max = parseDuration(c.max_contract_duration);
    if (!min || !max) continue;
    if (unit === 't') {
      if ((min.unit ?? 't') !== 't' || (max.unit ?? 't') !== 't') continue;
      if (duration >= min.value && duration <= max.value) return { ok: true, reason: `${contractType} ${duration}t dentro de ${c.min_contract_duration}–${c.max_contract_duration}` };
    } else {
      if (!min.unit || !max.unit || min.unit === 't' || max.unit === 't') continue;
      const d = duration * UNIT_SECONDS[unit]!;
      const lo = min.value * UNIT_SECONDS[min.unit]!, hi = max.value * UNIT_SECONDS[max.unit]!;
      if (d >= lo && d <= hi) return { ok: true, reason: `${contractType} ${duration}${unit} dentro de ${c.min_contract_duration}–${c.max_contract_duration}` };
    }
  }
  return { ok: false, reason: `duração ${duration}${unit} fora dos limites oferecidos para ${contractType}` };
}

export function signalKey(symbol: string, strategy: string, epoch: number): string {
  return `${symbol}:${strategy}:${epoch}`;
}

/**
 * Agente 4 — Signal Validator. Rejeita sinais que não podem ser executados com segurança.
 * A unicidade definitiva é garantida pelo banco (UNIQUE em decisions e trades.signal_key).
 */
export class SignalValidator {
  private recent = new Set<string>();
  private order: string[] = [];

  validate(d: Decision, tick: NormalizedTick, s: Settings, symbolInfo: ActiveSymbol | null, contracts: readonly ContractAvailable[], now = Date.now()): ValidationResult {
    const key = signalKey(tick.symbol, s.strategy, tick.epoch);
    const no = (reason: string): ValidationResult => ({ ok: false, reason, signalKey: key });
    if (d.action === 'AGUARDAR') return no('estratégia retornou AGUARDAR');
    if (this.recent.has(key)) return no('sinal duplicado para o mesmo evento de mercado');
    if (tick.symbol !== s.symbol) return no('cotação de outro símbolo');
    const ageS = (now - tick.receivedAt) / 1000;
    if (ageS > s.risk.maxTickAgeSeconds) return no(`cotação com ${ageS.toFixed(1)} s (limite ${s.risk.maxTickAgeSeconds} s)`);
    if (tick.source !== 'deriv:ticks') return no('sinal baseado em histórico, não em cotação ao vivo');
    if (!symbolInfo) return no('símbolo não confirmado em active_symbols');
    if (symbolInfo.exchange_is_open !== 1) return no('mercado fechado');
    if (symbolInfo.is_trading_suspended === 1) return no('negociação suspensa');
    const offered = contractOffered(contracts, d.action, s.contractDuration, s.durationUnit);
    if (!offered.ok) return no(offered.reason);
    this.remember(key);
    return { ok: true, reason: offered.reason, signalKey: key };
  }

  private remember(key: string): void {
    this.recent.add(key);
    this.order.push(key);
    while (this.order.length > 5000) this.recent.delete(this.order.shift()!);
  }
}
