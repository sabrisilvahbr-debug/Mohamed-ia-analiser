import { EventEmitter } from 'node:events';
import type { Store, EventRow } from '../db.ts';
import type { AgentRegistry } from './base.ts';
import { logger, redact } from '../logger.ts';

/** Agente 8 — Audit: persiste todo evento relevante e o publica para o painel (SSE). */
export class AuditAgent extends EventEmitter {
  private readonly log = logger('audit');
  private failures = 0;
  private readonly store: Store;
  private readonly registry: AgentRegistry;

  constructor(store: Store, registry: AgentRegistry) {
    super();
    this.store = store;
    this.registry = registry;
    this.registry.update('audit', { status: 'ok', detail: 'gravando eventos no SQLite', activity: false });
  }

  record(level: EventRow['level'], agent: string, type: string, message: string, data?: unknown): EventRow | null {
    const safeMessage = redact(message);
    const safeData = data === undefined ? undefined : JSON.parse(redact(JSON.stringify(data)));
    try {
      const row = this.store.addEvent({ level, agent, type, message: safeMessage, data: safeData });
      this.registry.count('audit', 'eventos');
      this.registry.update('audit', { status: 'ok', detail: `último: ${type}` });
      this.failures = 0;
      this.emit('event', row);
      return row;
    } catch (e) {
      this.failures++;
      this.log.error('falha ao gravar evento', e);
      this.registry.update('audit', { status: 'error', lastError: (e as Error).message, detail: 'banco indisponível' });
      this.emit('failure', e);
      return null;
    }
  }

  healthy(): boolean { return this.failures === 0; }
}
