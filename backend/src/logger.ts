/**
 * Logger com redação de segredos. Qualquer valor registrado via
 * registerSecret() é substituído por "***" antes de ir para stdout.
 * Também mascara parâmetros "otp=" em URLs e cabeçalhos Bearer.
 */
const secrets = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  out = out.replace(/([?&]otp=)[^&\s"']+/gi, '$1***');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1***');
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  const line: Record<string, unknown> = { t: new Date().toISOString(), level, scope, msg };
  if (extra !== undefined) line.extra = extra instanceof Error ? { name: extra.name, message: extra.message } : extra;
  const text = redact(JSON.stringify(line));
  const silent = typeof process !== 'undefined' && process.env?.LOG_SILENT === '1';
  if (level === 'error' || level === 'warn') console.error(text);
  else if (!silent) console.log(text);
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => { if (typeof process !== 'undefined' && process.env?.LOG_DEBUG === '1') emit('debug', scope, m, e); },
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}
export type Logger = ReturnType<typeof logger>;
