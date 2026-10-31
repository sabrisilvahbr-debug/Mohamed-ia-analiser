/**
 * Declarações mínimas do runtime Cloudflare usadas pelo worker.ts (para checagem de tipos
 * local, sem baixar @cloudflare/workers-types). O build da Cloudflare usa o runtime real.
 */
declare module 'cloudflare:workers' {
  export interface SqlStorageCursor<T = Record<string, unknown>> extends Iterable<T> {
    toArray(): T[];
    one(): T;
    readonly rowsWritten: number;
    readonly rowsRead: number;
  }
  export interface SqlStorage {
    exec<T = Record<string, unknown>>(query: string, ...bindings: (string | number | null)[]): SqlStorageCursor<T>;
  }
  export interface DurableObjectStorage {
    readonly sql: SqlStorage;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number): Promise<void>;
  }
  export interface DurableObjectState {
    readonly storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  }
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

interface DurableObjectStubLike { fetch(input: Request | string, init?: RequestInit): Promise<Response> }
interface DurableObjectNamespaceLike { idFromName(name: string): unknown; get(id: unknown): DurableObjectStubLike }
interface FetcherLike { fetch(input: Request | string): Promise<Response> }
interface ExecutionContextLike { waitUntil(p: Promise<unknown>): void }
