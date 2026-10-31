/**
 * AI OTC TRADER 3D — Cloudflare Workers + Durable Object (plano gratuito).
 *
 * - O painel (frontend/) é servido como Static Assets.
 * - /api/* e /health* vão para um único Durable Object ("main"), que roda o MESMO
 *   Supervisor do servidor Node: agentes, risco, conexão com a Deriv e SQLite.
 * - O objeto fica ativo pela conexão WebSocket de saída com a Deriv, por um alarme a cada
 *   30 s e por um cron por minuto, que o recria se o Cloudflare o tiver descarregado.
 *   O estado (operações, eventos, configurações) persiste no SQLite do Durable Object.
 */
import { DurableObject } from 'cloudflare:workers';
import { readConfig, secretValues } from '../../backend/src/config.ts';
import { Store } from '../../backend/src/db.ts';
import { Supervisor } from '../../backend/src/agents/supervisor.ts';
import { createApi, type Api } from '../../backend/src/api.ts';
import { registerSecret, logger } from '../../backend/src/logger.ts';
import { doSqlDriver } from './sql-driver.ts';

interface Env {
  TRADER: DurableObjectNamespaceLike;
  ASSETS: FetcherLike;
  ADMIN_TOKEN?: string;
  DERIV_APP_ID?: string;
  DERIV_PAT?: string;
  DERIV_ACCOUNT_ID?: string;
  ALLOW_REAL_TRADING?: string;
  ALLOWED_ORIGINS?: string;
  /** opcionais (padrão: endpoints oficiais da Deriv) */
  DERIV_PUBLIC_WS?: string;
  DERIV_REST_BASE?: string;
}

const log = logger('cloudflare');
const KEEPALIVE_MS = 30_000;

export class TraderEngine extends DurableObject<Env> {
  private sup: Supervisor | null = null;
  private api: Api | null = null;
  private bootError: string | null = null;

  constructor(ctx: ConstructorParameters<typeof DurableObject<Env>>[0], env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.boot();
      await this.ensureAlarm();
    });
  }

  private boot(): void {
    if (this.sup) return;
    try {
      const vars: Record<string, string | undefined> = {
        ADMIN_TOKEN: this.env.ADMIN_TOKEN,
        DERIV_APP_ID: this.env.DERIV_APP_ID,
        DERIV_PAT: this.env.DERIV_PAT,
        DERIV_ACCOUNT_ID: this.env.DERIV_ACCOUNT_ID,
        ALLOW_REAL_TRADING: this.env.ALLOW_REAL_TRADING,
        ALLOWED_ORIGINS: this.env.ALLOWED_ORIGINS,
        DERIV_PUBLIC_WS: this.env.DERIV_PUBLIC_WS,
        DERIV_REST_BASE: this.env.DERIV_REST_BASE,
        DB_PATH: 'durable-object-sqlite',
      };
      const cfg = readConfig(vars);
      for (const s of secretValues(cfg)) registerSecret(s);
      const store = new Store(doSqlDriver(this.ctx.storage.sql));
      this.sup = new Supervisor({ config: cfg, store });
      this.api = createApi(cfg, store, this.sup);
      this.sup.start();
      this.bootError = null;
      log.info('motor iniciado no Durable Object');
    } catch (e) {
      this.bootError = (e as Error).message;
      log.error('falha ao iniciar o motor', e);
    }
  }

  private async ensureAlarm(): Promise<void> {
    const at = await this.ctx.storage.getAlarm();
    if (!at || at < Date.now()) await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  /** Alarme periódico: mantém o objeto ativo e reinicia o motor se necessário. */
  async alarm(): Promise<void> {
    this.boot();
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  async fetch(request: Request): Promise<Response> {
    this.boot();
    await this.ensureAlarm();
    if (!this.api) {
      return new Response(JSON.stringify({ error: `motor não iniciou: ${this.bootError ?? 'desconhecido'}` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    const ip = request.headers.get('cf-connecting-ip') ?? '?';
    return this.api.handle(request, ip);
  }
}

function engine(env: Env): DurableObjectStubLike {
  return env.TRADER.get(env.TRADER.idFromName('main'));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/') || pathname === '/health' || pathname === '/health/ready') {
      return engine(env).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
  /** Cron (1/min): acorda o motor caso o Cloudflare o tenha descarregado. */
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(engine(env).fetch('https://engine.internal/health').then((r) => r.text()));
  },
};
