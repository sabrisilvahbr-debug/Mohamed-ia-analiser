import { existsSync } from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  port: number;
  adminToken: string | null;
  dbPath: string;
  deriv: {
    appId: string | null;
    pat: string | null;
    accountId: string | null;
    restBase: string;
    publicWs: string;
  };
  allowRealTrading: boolean;
  frontendDir: string;
}

function str(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  if (v === undefined) return null;
  const t = v.trim();
  return t.length ? t : null;
}

/** Carrega .env (se existir) sem dependências externas. */
export function loadDotEnv(file = '.env'): void {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(str(env, 'PORT') ?? '8080');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT inválida: ${env.PORT}`);
  }
  const adminToken = str(env, 'ADMIN_TOKEN');
  const restBase = str(env, 'DERIV_REST_BASE') ?? 'https://api.derivws.com';
  const publicWs = str(env, 'DERIV_PUBLIC_WS') ?? 'wss://api.derivws.com/trading/v1/options/ws/public';
  for (const [k, u, proto] of [['DERIV_REST_BASE', restBase, 'https:'], ['DERIV_PUBLIC_WS', publicWs, 'wss:']] as const) {
    const parsed = new URL(u);
    if (parsed.protocol !== proto && !(parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
      throw new Error(`${k} deve usar ${proto}`);
    }
  }
  return {
    port,
    adminToken: adminToken && adminToken.length >= 16 ? adminToken : null,
    dbPath: str(env, 'DB_PATH') ?? './data/trader.db',
    deriv: {
      appId: str(env, 'DERIV_APP_ID'),
      pat: str(env, 'DERIV_PAT'),
      accountId: str(env, 'DERIV_ACCOUNT_ID'),
      restBase,
      publicWs,
    },
    allowRealTrading: str(env, 'ALLOW_REAL_TRADING') === 'true',
    frontendDir: path.resolve(import.meta.dirname, '../../frontend'),
  };
}

export function hasDerivCredentials(c: AppConfig): boolean {
  return Boolean(c.deriv.appId && c.deriv.pat && c.deriv.accountId);
}

/** Lista de valores secretos que nunca podem aparecer em logs. */
export function secretValues(c: AppConfig): string[] {
  return [c.adminToken, c.deriv.pat].filter((v): v is string => typeof v === 'string' && v.length > 0);
}
