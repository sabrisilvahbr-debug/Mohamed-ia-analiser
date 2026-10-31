import { EventEmitter } from 'node:events';

export type AgentId =
  | 'market_data'
  | 'market_analyzer'
  | 'strategy_engine'
  | 'signal_validator'
  | 'risk_manager'
  | 'execution_engine'
  | 'portfolio_monitor'
  | 'audit'
  | 'supervisor';

/**
 * Estados operacionais reais. Um agente só muda de estado quando executa trabalho
 * ou detecta uma falha — nada aqui é animação ou preenchimento visual.
 */
export type AgentStatus = 'idle' | 'ok' | 'waiting' | 'degraded' | 'error' | 'stopped';

export interface AgentSnapshot {
  id: AgentId;
  name: string;
  role: string;
  status: AgentStatus;
  detail: string;
  lastActivityAt: string | null;
  counters: Record<string, number>;
  lastError: string | null;
}

export const AGENT_META: Record<AgentId, { name: string; role: string }> = {
  market_data: { name: 'Market Data', role: 'Recebe e normaliza cotações da Deriv' },
  market_analyzer: { name: 'Market Analyzer', role: 'Calcula tendência, EMA, RSI e volatilidade' },
  strategy_engine: { name: 'Strategy Engine', role: 'Aplica as regras da estratégia selecionada' },
  signal_validator: { name: 'Signal Validator', role: 'Valida oportunidades e bloqueia duplicatas' },
  risk_manager: { name: 'Risk Manager', role: 'Limites de exposição, perda diária e bloqueios' },
  execution_engine: { name: 'Execution Engine', role: 'Envia propostas e ordens autorizadas' },
  portfolio_monitor: { name: 'Portfolio Monitor', role: 'Acompanha contratos, saldo e resultados' },
  audit: { name: 'Audit Agent', role: 'Registra eventos e decisões no banco' },
  supervisor: { name: 'Supervisor', role: 'Coordena módulos e interrompe entradas em falhas' },
};

export class AgentRegistry extends EventEmitter {
  private agents = new Map<AgentId, AgentSnapshot>();

  constructor() {
    super();
    for (const id of Object.keys(AGENT_META) as AgentId[]) {
      this.agents.set(id, { id, ...AGENT_META[id], status: 'idle', detail: 'aguardando inicialização', lastActivityAt: null, counters: {}, lastError: null });
    }
  }

  update(id: AgentId, patch: Partial<Pick<AgentSnapshot, 'status' | 'detail' | 'lastError'>> & { activity?: boolean }): void {
    const a = this.agents.get(id)!;
    if (patch.status) a.status = patch.status;
    if (patch.detail !== undefined) a.detail = patch.detail;
    if (patch.lastError !== undefined) a.lastError = patch.lastError;
    if (patch.activity !== false) a.lastActivityAt = new Date().toISOString();
    this.emit('change', id);
  }

  count(id: AgentId, counter: string, by = 1): void {
    const a = this.agents.get(id)!;
    a.counters[counter] = (a.counters[counter] ?? 0) + by;
  }

  get(id: AgentId): AgentSnapshot { return structuredClone(this.agents.get(id)!); }
  list(): AgentSnapshot[] { return [...this.agents.values()].map((a) => structuredClone(a)); }
}
