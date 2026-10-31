/**
 * Gera frontend/lib/*.js a partir do MESMO código TypeScript do backend (indicadores,
 * estratégias, análise, validação, configurações), removendo apenas as anotações de tipo.
 * Assim o modo direto do painel usa exatamente a lógica testada em backend/test.
 * Uso: npm run build:lib   (o teste lib-sync.test.ts falha se os arquivos estiverem desatualizados)
 */
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const LIB_FILES = ['settings.ts', 'strategies/indicators.ts', 'strategies/engine.ts', 'agents/analyzer.ts', 'agents/validator.ts'];
const root = path.resolve(import.meta.dirname, '..');

export function buildLib(file: string): string {
  const src = readFileSync(path.join(root, 'backend/src', file), 'utf8');
  const js = stripTypeScriptTypes(src, { mode: 'strip' })
    .replace(/from '(\.{1,2}\/[^']+)\.ts'/g, "from '$1.js'")
    .replace(/^\s*import\s+'[^']*';?\s*$/gm, '');
  return `// GERADO por scripts/build-frontend-lib.ts a partir de backend/src/${file} — não editar.\n${js}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  for (const f of LIB_FILES) {
    const out = path.join(root, 'frontend/lib', f.replace(/\.ts$/, '.js'));
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, buildLib(f));
    console.log('gerado', path.relative(root, out));
  }
}
