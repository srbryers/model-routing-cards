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

test('global install falls back to XDG config after env, env-file and repo-local config', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'jev-xdg-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const xdg = join(root, 'config'); mkdirSync(join(xdg, 'model-routing'), { recursive: true });
  const configFile = join(root, 'package-config.json');
  const xdgConfigFile = join(xdg, 'model-routing', 'jev.local.json');
  writeFileSync(join(xdg, 'model-routing', 'store.env'), 'TYPESAFE_API_KEY=xdg-fixture');
  writeFileSync(xdgConfigFile, JSON.stringify({ envFile: 'store.env' }));
  const env = { XDG_CONFIG_HOME: xdg };
  assert.equal(readJevKey({ env, configFile }), 'xdg-fixture');
  writeFileSync(join(root, 'repo.env'), 'TYPESAFE_API_KEY=repo-fixture');
  writeFileSync(configFile, JSON.stringify({ envFile: 'repo.env' }));
  assert.equal(readJevKey({ env, configFile }), 'repo-fixture');
  writeFileSync(join(root, 'explicit.env'), 'TYPESAFE_API_KEY=explicit-fixture');
  env.TYPESAFE_ENV_FILE = join(root, 'explicit.env');
  assert.equal(readJevKey({ env, configFile }), 'explicit-fixture');
  env.TYPESAFE_API_KEY = 'env-fixture';
  assert.equal(readJevKey({ env, configFile }), 'env-fixture');
});

test('XDG config defaults to home .config without depending on caller cwd', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'jev-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, '.config', 'model-routing'); mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'jev.local.json'), JSON.stringify({ envFile: 'fixture.env' }));
  writeFileSync(join(config, 'fixture.env'), 'TYPESAFE_API_KEY=home-fixture');
  assert.equal(readJevKey({ env: { HOME: root }, configFile: join(root, 'missing.json') }), 'home-fixture');
});
