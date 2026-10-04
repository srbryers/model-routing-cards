import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, resolveCandidates, validatePolicy } from './policy.mjs';
import { loadLocalConfig, validateLocalConfig } from './local-config.mjs';
const policy = loadPolicy();
const config = { routes: { 'pi-local': { model: 'local-test-model' } } };

test('only model values on explicitly local routes may be configured', () => {
  assert.deepEqual(validateLocalConfig(config, policy), { ok: true, errors: [] });
  for (const invalid of [null, {}, { routes: [] }, { routes: {}, machine: 'pc' },
    { routes: { muse: { model: 'another-model' } } }, { routes: { unknown: { model: 'test' } } },
    { routes: { 'pi-local': { model: '', provider: 'test' } } },
    { routes: { 'pi-local': { model: null } } }, { routes: { 'pi-local': { model: '   ' } } },
    { routes: { 'pi-local': { model: 'test', reasoning: 'high' } } },
    { routes: { 'pi-local': { model: 'test-contributor' } } }]) {
    assert.equal(validateLocalConfig(invalid, policy).ok, false);
  }
});
test('XDG config location wins, home default works, and missing files are optional', () => {
  for (const [env, expected] of [
    [{ HOME: '/tmp/local-home', XDG_CONFIG_HOME: '/tmp/local-xdg' }, '/tmp/local-xdg/model-routing/local.json'],
    [{ HOME: '/tmp/local-home' }, '/tmp/local-home/.config/model-routing/local.json'],
  ]) {
    assert.deepEqual(loadLocalConfig(policy, { env, readFile: (file, encoding) => {
      assert.equal(file, expected); assert.equal(encoding, 'utf8'); return JSON.stringify(config);
    } }), config);
  }
  assert.deepEqual(loadLocalConfig(policy, { env: { HOME: '/tmp/local-home' }, readFile: () => {
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  } }), { routes: {} });
});
test('bad local files return safe diagnostics with the full path', () => {
  for (const [readFile, message] of [
    [() => '{"model":"private-model-value"', /must be valid JSON/],
    [() => { throw Object.assign(new Error('private-path'), { code: 'EACCES' }); }, /could not be read/],
    [() => JSON.stringify({ routes: { muse: { model: 'private-model-value' } } }), /invalid local model configuration/],
  ]) {
    const result = loadLocalConfig(policy, { env: { HOME: '/tmp/local-home' }, readFile });
    assert.deepEqual(result.routes, {});
    assert.match(result.error, message); assert.doesNotMatch(result.error, /private-/);
    assert.ok(result.error.startsWith('/tmp/local-home/.config/model-routing/local.json: '));
  }
});
test('resolver uses an injected local model without modifying public policy', () => {
  const configured = resolveCandidates(policy, 'bulk-text', { localConfig: config });
  assert.equal(configured.candidates[0].route, 'pi-local');
  assert.equal(configured.candidates[0].model, 'local-test-model');
  assert.equal(policy.routes['pi-local'].model, null);
  const missing = resolveCandidates(policy, 'bulk-text');
  assert.deepEqual(missing.candidates.map(c => c.route), ['muse', 'luna']);
  assert.ok(missing.blocked.some(c => c.why === 'pi-local model not configured in local.json'));
  assert.throws(() => resolveCandidates(policy, 'bulk-text', { localConfig: { routes: { muse: { model: 'test' } } } }), /Invalid local config/);
});
test('local model declarations require a null placeholder and local source', () => {
  for (const mutate of [p => p.routes['pi-local'].model = 'embedded-model',
    p => p.routes['pi-local'].modelFrom = 'env', p => delete p.routes['pi-local'].modelFrom]) {
    const p = structuredClone(policy); mutate(p); assert.equal(validatePolicy(p).ok, false);
  }
});
