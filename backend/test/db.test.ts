import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../src/db-node.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

const tradeInput = (key: string) => ({ signal_key: key, account_mode: 'demo', account_id: 'DOT1', symbol: 'R_100', contract_type: 'CALL', duration: 5, duration_unit: 't', stake: 1, currency: 'USD' });

test('banco: signal_key único impede ordem duplicada', () => {
  const s = openStore(':memory:');
  assert.ok(s.createTrade(tradeInput('a')));
  assert.equal(s.createTrade(tradeInput('a')), null);
  assert.ok(s.createTrade(tradeInput('b')));
  s.close();
});

test('banco: decisão única por (símbolo, estratégia, tick)', () => {
  const s = openStore(':memory:');
  const d = { symbol: 'R_100', strategy: 'ema_cross', tick_epoch: 1, action: 'CALL', reason: 'x', indicators: '{}', verdict: 'pending', verdict_reason: null };
  assert.ok(s.addDecision(d));
  assert.equal(s.addDecision(d), null);
  s.close();
});

test('banco: resultado realizado considera apenas SETTLED; perdas consecutivas', () => {
  const s = openStore(':memory:');
  const today = new Date().toISOString().slice(0, 10);
  const mk = (k: string, profit: number) => {
    const t = s.createTrade(tradeInput(k))!;
    s.updateTrade(t.id, { state: 'SETTLED', profit, settled_at: new Date().toISOString() });
  };
  mk('1', 0.95); mk('2', -1); mk('3', -1);
  const open = s.createTrade(tradeInput('4'))!;
  s.updateTrade(open.id, { state: 'OPEN', profit: 5 }); // não liquidado: não conta
  const r = s.realizedForDay(today, 'demo');
  assert.equal(Number(r.pnl.toFixed(2)), -1.05);
  assert.equal(r.settled, 3);
  assert.equal(s.consecutiveLosses('demo'), 2);
  assert.equal(s.listActiveTrades().length, 1);
  s.close();
});

test('banco: configurações e estado desejado persistem entre reinícios', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trader-'));
  const file = path.join(dir, 't.db');
  const a = openStore(file);
  a.saveSettings({ ...DEFAULT_SETTINGS, stake: 2 });
  a.setDesired('RUNNING');
  a.close();
  const b = openStore(file);
  assert.equal(b.getSettings().stake, 2);
  assert.equal(b.getDesired(), 'RUNNING');
  b.close();
});

test('banco: lock impede duas instâncias simultâneas', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trader-'));
  const file = path.join(dir, 'l.db');
  const a = openStore(file);
  const b = openStore(file);
  const now = Date.now();
  assert.equal(a.acquireLock(30_000, now), true);
  assert.equal(b.acquireLock(30_000, now + 1000), false);
  assert.equal(a.acquireLock(30_000, now + 2000), true); // renovação
  assert.equal(b.acquireLock(30_000, now + 40_000), true); // lock velho é assumido
  assert.equal(a.acquireLock(30_000, now + 40_001), false);
  a.close(); b.close();
});
