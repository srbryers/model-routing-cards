import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCard } from './cards.mjs';

test('findCard quarantines a stored card with a stale Luna identity', t => {
  const cardsDir = mkdtempSync(join(tmpdir(), 'cards-'));
  t.after(() => rmSync(cardsDir, { recursive: true, force: true }));
  writeFileSync(join(cardsDir, 'quick-edit.card.json'), JSON.stringify({
    task: 'quick-edit', trust: 'CALIBRATED', generated: '2026-10-04', recommend: 'openai/gpt-6-luna',
  }));
  let found;
  assert.doesNotThrow(() => {
    found = findCard('quick-edit.card.json', { cardsDir, repoDir: cardsDir, env: { HOME: cardsDir } });
  });
  assert.equal(Object.hasOwn(found, 'card'), false);
  assert.deepEqual(found.why, ['card quick-edit.card.json stale Luna identity quarantined and ignored']);
});
