import type { Settings } from '../settings.ts';

export interface RiskContext {
  executionMode: Settings['executionMode'];
  allowRealTrading: boolean;
  /** Modo da conta conectada, derivado da URL de WebSocket retornada pelo OTP. */
  accountMode: 'demo' | 'real' | 'desconhecido' | null;
  /** Saldo informado pela Deriv (balance). null = não disponível. */
  balance: number | null;
  balanceAgeMs: number | null;
  /** Resultado realizado do dia (UTC), apenas contratos liquidados. */
  realizedToday: number;
  openCount: number;
  /** Soma dos stakes de contratos abertos ou sem confirmação. */
  openExposure: number;
  unconfirmedCount: number;
  consecutiveLosses: number;
  lastEntryAt: number | null;
  now: number;
}

export interface RiskVerdict { ok: boolean; reasons: string[]; blocking: string[] }

/**
 * Agente 5 — Risk Manager (validação 100% no backend).
 * Stake é sempre o configurado: não existe progressão após perdas.
 */
export function checkRisk(s: Settings, c: RiskContext): RiskVerdict {
  const r = s.risk;
  const blocking: string[] = [];
  const stake = s.stake;

  if (c.executionMode === 'signals') blocking.push('modo SINAIS: nenhuma ordem é enviada');
  if (c.executionMode === 'real' && !c.allowRealTrading) blocking.push('execução real desativada no servidor (ALLOW_REAL_TRADING≠true)');
  if (c.executionMode !== 'signals') {
    if (c.accountMode === null) blocking.push('conta Deriv não conectada');
    else if (c.accountMode !== c.executionMode) blocking.push(`conta conectada é ${c.accountMode}, modo selecionado é ${c.executionMode}`);
  }
  if (stake > r.maxStakePerTrade) blocking.push(`stake ${stake} acima do limite por operação ${r.maxStakePerTrade}`);
  if (c.balance === null) blocking.push('saldo não confirmado pela Deriv');
  else if (stake > c.balance) blocking.push(`saldo ${c.balance} insuficiente para stake ${stake}`);
  if (c.balanceAgeMs !== null && c.balanceAgeMs > 10 * 60_000) blocking.push('saldo desatualizado (>10 min)');
  const lossSoFar = Math.max(0, -c.realizedToday);
  if (lossSoFar >= r.maxDailyLoss) blocking.push(`limite de perda diária atingido (${lossSoFar.toFixed(2)}/${r.maxDailyLoss})`);
  else if (lossSoFar + c.openExposure + stake > r.maxDailyLoss) blocking.push(`pior cenário (${(lossSoFar + c.openExposure + stake).toFixed(2)}) ultrapassaria a perda diária máxima ${r.maxDailyLoss}`);
  if (c.openCount >= r.maxOpenContracts) blocking.push(`${c.openCount} contrato(s) aberto(s) — limite ${r.maxOpenContracts}`);
  if (c.openExposure + stake > r.maxExposure) blocking.push(`exposição ${(c.openExposure + stake).toFixed(2)} acima do limite ${r.maxExposure}`);
  if (c.unconfirmedCount > 0) blocking.push(`${c.unconfirmedCount} ordem(ns) sem confirmação — reconciliação pendente`);
  if (c.consecutiveLosses >= r.maxConsecutiveLosses) blocking.push(`${c.consecutiveLosses} perdas seguidas (limite ${r.maxConsecutiveLosses})`);
  if (c.lastEntryAt !== null && c.now - c.lastEntryAt < r.cooldownSeconds * 1000) {
    blocking.push(`intervalo mínimo entre entradas: faltam ${Math.ceil((r.cooldownSeconds * 1000 - (c.now - c.lastEntryAt)) / 1000)} s`);
  }
  return { ok: blocking.length === 0, reasons: blocking.length ? blocking : ['todos os limites respeitados'], blocking };
}
