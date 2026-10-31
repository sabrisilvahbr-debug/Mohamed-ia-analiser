import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LIB_FILES, buildLib } from '../../scripts/build-frontend-lib.ts';

test('frontend/lib está sincronizado com o código do backend (rode npm run build:lib)', () => {
  for (const f of LIB_FILES) {
    const out = path.resolve(import.meta.dirname, '../../frontend/lib', f.replace(/\.ts$/, '.js'));
    assert.equal(readFileSync(out, 'utf8'), buildLib(f), `${f} desatualizado`);
  }
});
