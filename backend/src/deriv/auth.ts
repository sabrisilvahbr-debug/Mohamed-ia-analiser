/**
 * Autenticação conforme https://developers.deriv.com/docs/options/websocket/ :
 *   POST {REST}/trading/v1/options/accounts/{accountId}/otp
 *   Authorization: Bearer <PAT>   +   Deriv-App-ID: <app id>   (obrigatório com PAT)
 *   resposta: { data: { url: "wss://api.derivws.com/trading/v1/options/ws/demo?otp=..." } }
 * Cada OTP é de uso único e expira em 120 s, por isso é pedido a cada (re)conexão.
 */
export interface DerivAuthConfig { restBase: string; appId: string; pat: string; accountId: string }

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

/** GET /trading/v1/options/accounts — usado apenas no diagnóstico. A documentação não publica o formato da resposta. */
export async function listAccounts(c: DerivAuthConfig, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number; summary: string }> {
  const res = await fetchImpl(`${c.restBase}/trading/v1/options/accounts`, { headers: headers(c), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return { ok: false, status: res.status, summary: await readError(res) };
  const body = (await res.json()) as { data?: unknown };
  const n = Array.isArray(body.data) ? body.data.length : null;
  return { ok: true, status: res.status, summary: n === null ? 'resposta recebida' : `${n} conta(s) retornada(s)` };
}
