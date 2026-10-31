/**
 * Autenticação conforme https://developers.deriv.com/docs/options/websocket/ :
 *   POST {REST}/trading/v1/options/accounts/{accountId}/otp
 *   Authorization: Bearer <PAT>   +   Deriv-App-ID: <app id>   (obrigatório com PAT)
 *   resposta: { data: { url: "wss://api.derivws.com/trading/v1/options/ws/demo?otp=..." } }
 * Cada OTP é de uso único e expira em 120 s, por isso é pedido a cada (re)conexão.
 */
export interface DerivAuthConfig { restBase: string; appId: string; pat: string; accountId: string }
export type DerivCredentials = Omit<DerivAuthConfig, 'accountId'> & { accountId: string | null };

export interface OptionsAccount { account_id: string; account_type: string | null; status: string | null; currency: string | null }

/** GET /trading/v1/options/accounts — formato conforme exemplos da documentação (data[].account_id, account_type, status). */
export async function fetchAccounts(c: Omit<DerivAuthConfig, 'accountId'>, fetchImpl: typeof fetch = fetch): Promise<OptionsAccount[]> {
  const res = await fetchImpl(`${c.restBase}/trading/v1/options/accounts`, { headers: headers({ ...c, accountId: '' }), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`lista de contas recusada: ${await readError(res)}`);
  const body = (await res.json()) as { data?: unknown };
  const list = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
  return list.flatMap((a): OptionsAccount[] => {
    if (typeof a !== 'object' || a === null) return [];
    const r = a as Record<string, unknown>;
    if (typeof r.account_id !== 'string') return [];
    return [{ account_id: r.account_id, account_type: typeof r.account_type === 'string' ? r.account_type : null, status: typeof r.status === 'string' ? r.status : null, currency: typeof r.currency === 'string' ? r.currency : null }];
  });
}

/** Escolhe a conta DEMO ativa. Nunca escolhe uma conta real automaticamente. */
export function pickDemoAccount(accounts: readonly OptionsAccount[]): OptionsAccount | null {
  return accounts.find((a) => a.account_type === 'demo' && (a.status === null || a.status === 'active')) ?? null;
}

export type AccountMode = 'demo' | 'real' | 'desconhecido';

export function modeFromWsUrl(url: string): AccountMode {
  const p = new URL(url).pathname;
  if (/\/ws\/demo\/?$/.test(p)) return 'demo';
  if (/\/ws\/real\/?$/.test(p)) return 'real';
  return 'desconhecido';
}

function headers(c: DerivAuthConfig): Record<string, string> {
  return { Authorization: `Bearer ${c.pat}`, 'Deriv-App-ID': c.appId, Accept: 'application/json' };
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { errors?: { code?: string; message?: string }[] };
    const e = body.errors?.[0];
    if (e) return `${res.status} ${e.code ?? ''} ${e.message ?? ''}`.trim();
  } catch { /* corpo não-JSON */ }
  return `HTTP ${res.status}`;
}

export async function requestOtpUrl(c: DerivAuthConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!/^[A-Za-z0-9]{2,30}$/.test(c.accountId)) throw new Error('DERIV_ACCOUNT_ID com formato inválido');
  const url = `${c.restBase}/trading/v1/options/accounts/${encodeURIComponent(c.accountId)}/otp`;
  const res = await fetchImpl(url, { method: 'POST', headers: headers(c), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OTP recusado pela Deriv: ${await readError(res)}`);
  const body = (await res.json()) as { data?: { url?: unknown } };
  const wsUrl = body.data?.url;
  if (typeof wsUrl !== 'string') throw new Error('resposta de OTP sem data.url');
  const parsed = new URL(wsUrl);
  const restHost = new URL(c.restBase).hostname;
  if (parsed.protocol !== 'wss:' && !(parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) throw new Error('URL de WebSocket não usa wss://');
  if (parsed.hostname !== restHost) throw new Error(`URL de WebSocket em host inesperado (${parsed.hostname})`);
  return wsUrl;
}

/** Resumo para o diagnóstico: IDs e tipos das contas (não são segredos). */
export async function listAccounts(c: Omit<DerivAuthConfig, 'accountId'>, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; summary: string }> {
  try {
    const acc = await fetchAccounts(c, fetchImpl);
    return { ok: acc.length > 0, summary: acc.length ? acc.map((a) => `${a.account_id} (${a.account_type ?? '?'}${a.status ? ', ' + a.status : ''})`).join(' • ') : 'nenhuma conta Options retornada' };
  } catch (e) {
    return { ok: false, summary: (e as Error).message };
  }
}
