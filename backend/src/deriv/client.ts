import { EventEmitter } from 'node:events';
import { logger } from '../logger.ts';
import type { BaseResponse } from './protocol.ts';

/** Subconjunto da interface WebSocket do navegador/Node 22 usado aqui. */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

export class DerivApiError extends Error {
  readonly code: string;
  readonly msgType: string;
  readonly reqId: number | undefined;
  constructor(code: string, message: string, msgType: string, reqId?: number) {
    super(`${code}: ${message}`);
    this.code = code;
    this.msgType = msgType;
    this.reqId = reqId;
  }
}
export class DerivTimeoutError extends Error {
  readonly reqId: number;
  constructor(reqId: number, what: string) { super(`Tempo esgotado aguardando resposta de ${what} (req_id ${reqId})`); this.reqId = reqId; }
}
export class DerivDisconnectedError extends Error {
  readonly reqId: number | undefined;
  constructor(reqId?: number) { super('Conexão com a Deriv encerrada antes da resposta'); this.reqId = reqId; }
}

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface DerivSocketOptions {
  name: string;
  /** Retorna a URL de conexão. Para canais autenticados, deve buscar um NOVO OTP a cada chamada. */
  urlProvider: () => Promise<string>;
  wsFactory?: WsFactory;
  pingIntervalMs?: number;
  /** Se nenhum dado chegar nesse intervalo, a conexão é considerada morta e é reaberta. */
  silenceTimeoutMs?: number;
  requestTimeoutMs?: number;
  backoffMs?: number[];
}

interface Pending { resolve: (r: BaseResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; what: string }
interface StreamHandler { onMessage: (r: BaseResponse) => void; subscriptionId: string | null }

/**
 * Cliente WebSocket para a API da Deriv:
 *  - associa respostas às requisições via req_id (documentação: "Maps the request to its response")
 *  - mantém assinaturas (ticks, balance, proposal_open_contract) e roteia atualizações
 *  - envia { ping: 1 } a cada 30 s (Best practices) e detecta desconexões silenciosas
 *  - reconecta com backoff exponencial + jitter, pedindo nova URL (novo OTP) a cada tentativa
 */
export class DerivSocket extends EventEmitter {
  readonly name: string;
  status: SocketStatus = 'idle';
  url: string | null = null;
  lastMessageAt: number | null = null;
  connectedAt: number | null = null;
  reconnects = 0;
  lastError: string | null = null;

  private ws: WsLike | null = null;
  private nextReqId = 1;
  private pending = new Map<number, Pending>();
  private streams = new Map<number, StreamHandler>();
  private pingTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private readonly opts: Required<Omit<DerivSocketOptions, 'name' | 'urlProvider'>> & Pick<DerivSocketOptions, 'urlProvider'>;
  private readonly log;

  constructor(o: DerivSocketOptions) {
    super();
    this.name = o.name;
    this.log = logger(`deriv:${o.name}`);
    this.opts = {
      urlProvider: o.urlProvider,
      wsFactory: o.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike),
      pingIntervalMs: o.pingIntervalMs ?? 30_000,
      silenceTimeoutMs: o.silenceTimeoutMs ?? 75_000,
      requestTimeoutMs: o.requestTimeoutMs ?? 15_000,
      backoffMs: o.backoffMs ?? [1000, 2000, 4000, 8000, 16000, 30000],
    };
  }

  isOpen(): boolean { return this.status === 'open'; }

  start(): void {
    this.stopped = false;
    if (this.status === 'idle' || this.status === 'closed') void this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.teardown('parado pelo sistema');
    this.status = 'closed';
    this.emit('status', this.status);
  }

  private async open(): Promise<void> {
    this.status = this.attempt === 0 ? 'connecting' : 'reconnecting';
    this.emit('status', this.status);
    let url: string;
    try {
      url = await this.opts.urlProvider();
    } catch (e) {
      this.fail(`falha ao obter URL de conexão: ${(e as Error).message}`);
      return;
    }
    if (this.stopped) return;
    this.url = url;
    let ws: WsLike;
    try {
      ws = this.opts.wsFactory(url);
    } catch (e) {
      this.fail(`falha ao abrir WebSocket: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.status = 'open';
      this.connectedAt = Date.now();
      this.lastMessageAt = Date.now();
      this.attempt = 0;
      this.lastError = null;
      this.log.info('conectado');
      this.startTimers();
      this.emit('status', this.status);
      this.emit('open');
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this.handleMessage(ev.data); };
    ws.onerror = () => { if (this.ws === ws) this.lastError = 'erro de WebSocket'; };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.fail(`conexão encerrada (code ${ev.code ?? '?'}${ev.reason ? ', ' + ev.reason : ''})`);
    };
  }

  private fail(reason: string): void {
    this.lastError = reason;
    this.log.warn(reason);
    this.teardown(reason);
    if (this.stopped) { this.status = 'closed'; this.emit('status', this.status); return; }
    const base = this.opts.backoffMs[Math.min(this.attempt, this.opts.backoffMs.length - 1)] ?? 30_000;
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.attempt++;
    this.reconnects++;
    this.status = 'reconnecting';
    this.emit('status', this.status);
    this.emit('down', reason);
    this.retryTimer = setTimeout(() => { void this.open(); }, delay);
  }

  private teardown(reason: string): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.pingTimer = this.watchdog = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(1000, 'bye'); } catch { /* já fechado */ }
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new DerivDisconnectedError(id));
    }
    this.pending.clear();
    // Assinaturas pertencem à conexão; quem assinou precisa reassinar no evento 'open'.
    this.streams.clear();
    this.connectedAt = null;
    void reason;
  }

  private startTimers(): void {
    this.pingTimer = setInterval(() => {
      this.send({ ping: 1 }).catch(() => { /* tratado pelo watchdog */ });
    }, this.opts.pingIntervalMs);
    this.watchdog = setInterval(() => {
      if (this.lastMessageAt && Date.now() - this.lastMessageAt > this.opts.silenceTimeoutMs) {
        this.fail('sem dados da Deriv dentro do limite — reconectando');
      }
    }, Math.min(5000, this.opts.silenceTimeoutMs));
  }

  private handleMessage(raw: unknown): void {
    this.lastMessageAt = Date.now();
    let msg: BaseResponse;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as BaseResponse;
    } catch {
      this.log.warn('mensagem não-JSON ignorada');
      return;
    }
    const reqId = typeof msg.req_id === 'number' ? msg.req_id : undefined;
    if (reqId !== undefined) {
      const p = this.pending.get(reqId);
      if (p) {
        this.pending.delete(reqId);
        clearTimeout(p.timer);
        const err = extractError(msg);
        if (err) p.reject(new DerivApiError(err.code, err.message, msg.msg_type, reqId));
        else p.resolve(msg);
      }
      const s = this.streams.get(reqId);
      if (s) {
        if (msg.subscription?.id) s.subscriptionId = msg.subscription.id;
        if (!p) s.onMessage(msg);
      }
      return;
    }
    if (msg.subscription?.id) {
      for (const s of this.streams.values()) {
        if (s.subscriptionId === msg.subscription.id) { s.onMessage(msg); return; }
      }
    }
    this.emit('unrouted', msg);
  }

  /** Envia uma requisição e aguarda a resposta correspondente (req_id). */
  send<T extends BaseResponse = BaseResponse>(req: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const ws = this.ws;
    if (!ws || this.status !== 'open') return Promise.reject(new DerivDisconnectedError());
    const reqId = this.nextReqId++;
    const what = Object.keys(req)[0] ?? 'request';
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new DerivTimeoutError(reqId, what));
      }, timeoutMs ?? this.opts.requestTimeoutMs);
      this.pending.set(reqId, { resolve: resolve as (r: BaseResponse) => void, reject, timer, what });
      try {
        ws.send(JSON.stringify({ ...req, req_id: reqId }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(e as Error);
      }
    });
  }

  /** Último req_id emitido (para registro de auditoria antes do envio). */
  peekNextReqId(): number { return this.nextReqId; }

  /**
   * Assina um fluxo. A primeira resposta resolve a promessa; as atualizações seguintes
   * são entregues a onMessage. Retorna o id da assinatura (para forget).
   */
  async subscribe<T extends BaseResponse>(req: Record<string, unknown>, onMessage: (m: T) => void): Promise<{ first: T; subscriptionId: string | null; reqId: number }> {
    const reqId = this.nextReqId;
    const handler: StreamHandler = { onMessage: onMessage as (r: BaseResponse) => void, subscriptionId: null };
    this.streams.set(reqId, handler);
    try {
      const first = await this.send<T>({ ...req, subscribe: 1 });
      handler.subscriptionId = first.subscription?.id ?? null;
      return { first, subscriptionId: handler.subscriptionId, reqId };
    } catch (e) {
      this.streams.delete(reqId);
      throw e;
    }
  }

  async forget(subscriptionId: string): Promise<void> {
    for (const [k, s] of this.streams) if (s.subscriptionId === subscriptionId) this.streams.delete(k);
    if (this.isOpen()) await this.send({ forget: subscriptionId }).catch(() => undefined);
  }

  info() {
    return {
      name: this.name,
      status: this.status,
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      reconnects: this.reconnects,
      lastError: this.lastError,
      pendingRequests: this.pending.size,
      activeStreams: this.streams.size,
    };
  }
}

export function extractError(msg: BaseResponse): { code: string; message: string } | null {
  if (msg.error) return { code: msg.error.code ?? 'UnknownError', message: msg.error.message ?? 'erro sem mensagem' };
  if (Array.isArray(msg.errors) && msg.errors.length) {
    const e = msg.errors[0]!;
    return { code: e.code ?? String(e.status ?? 'UnknownError'), message: e.message ?? 'erro sem mensagem' };
  }
  return null;
}
