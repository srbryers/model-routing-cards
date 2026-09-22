import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJevKey } from './jev-key.mjs';

test('a process key takes precedence without opening a configured missing file', () => {
  assert.equal(readJevKey({ env: { TYPESAFE_API_KEY: 'environment-fixture',
    TYPESAFE_ENV_FILE: '/missing/fixture.env' } }), 'environment-fixture');
});

test('a fresh process without a key resolves the existing store beside the adapter config', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'jev-key-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'existing-project'));
  writeFileSync(join(root, 'existing-project', '.env'),
    'TYPESAFE_API_KEY=old-fixture\r\nexport TYPESAFE_API_KEY = "current-fixture" # current\r\n');
  const configFile = join(root, '.jev.local.json');
  writeFileSync(configFile, JSON.stringify({ envFile: 'existing-project/.env' }));
  assert.equal(readJevKey({ env: {}, configFile }), 'current-fixture');
  writeFileSync(join(root, 'override.env'), 'TYPESAFE_API_KEY=override-fixture');
  assert.equal(readJevKey({ env: { TYPESAFE_ENV_FILE: join(root, 'override.env') }, configFile }),
    'override-fixture');
  writeFileSync(join(root, 'existing-project', '.env'), 'TYPESAFE_API_KEY=old-fixture\nTYPESAFE_API_KEY=""');
  assert.throws(() => readJevKey({ env: {}, configFile }), /no non-empty TYPESAFE_API_KEY/);
});
