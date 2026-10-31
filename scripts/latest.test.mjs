import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalogue, resolveLatest } from './latest.mjs';

const catalogue = (...slugs) => ({ models: slugs.map(slug => ({ slug })) });
const fallback = (value, family = 'terra', standing = 'gpt-5.6-terra') => {
  assert.deepEqual(resolveLatest(value, family, standing), { family, latest: true,
    standingModel: standing, resolvedModel: standing, source: 'fallback', fallback: true });
};

test('latest terra selects the newest synthetic catalogue entry', () => {
  assert.deepEqual(resolveLatest(catalogue('gpt-5.6-terra', 'gpt-6.1-terra'), 'terra', 'gpt-5.6-terra'), {
    family: 'terra', latest: true, standingModel: 'gpt-5.6-terra', resolvedModel: 'gpt-6.1-terra', source: 'catalogue', fallback: false,
  });
});
test('latest sol compares numeric components: 6.1 > 6 > 5.6', () => {
  for (const [slugs, expected] of [
    [['gpt-5.6-sol', 'gpt-6-sol', 'gpt-6.1-sol'], 'gpt-6.1-sol'],
    [['gpt-5.6-sol', 'gpt-6-sol'], 'gpt-6-sol'],
    [['gpt-6.9-sol', 'gpt-6.10-sol'], 'gpt-6.10-sol'],
  ]) assert.equal(resolveLatest(catalogue(...slugs), 'sol', 'gpt-5.6-sol').resolvedModel, expected);
});
test('latest astra returns its single catalogue entry', () => {
  const result = resolveLatest(catalogue('gpt-6-astra'), 'astra', 'gpt-6-astra');
  assert.equal(result.resolvedModel, 'gpt-6-astra');
  assert.equal(result.source, 'catalogue');
  assert.equal(result.fallback, false);
});
test('latest absent family uses a marked standing fallback', () => {
  fallback(catalogue('gpt-6-astra'));
});
test('latest missing and malformed catalogues use a marked standing fallback', () => {
  for (const value of [undefined, null, {}, [], 'invalid', { models: null }, { models: {} }, { models: [] }]) fallback(value);
});
test('latest ignores unparseable slugs and malformed entries', () => {
  const value = catalogue('gpt-next-terra', 'gpt-6.1-terra-preview', 'other-99-terra', 'gpt-6..1-terra', 'gpt-6.1-sol', 'gpt-5.6-terra');
  value.models.push(null, {}, { slug: 42 });
  assert.equal(resolveLatest(value, 'terra', 'gpt-5-terra').resolvedModel, 'gpt-5.6-terra');
  fallback(catalogue('gpt-next-terra'));
});
test('latest ties prefer standing identity then catalogue order', () => {
  const value = catalogue('gpt-6.0-sol', 'gpt-6-sol', 'gpt-06-sol');
  assert.equal(resolveLatest(value, 'sol', 'gpt-6-sol').resolvedModel, 'gpt-6-sol');
  assert.equal(resolveLatest(value, 'sol', 'gpt-5-sol').resolvedModel, 'gpt-6.0-sol');
});
test('latest returns only a catalogue slug or the standing fallback', () => {
  for (const value of [catalogue('gpt-6-terra'), catalogue('gpt-next-terra'), catalogue('gpt-6-sol'), null]) {
    const result = resolveLatest(value, 'terra', 'gpt-5.6-terra');
    assert.ok(result.resolvedModel === result.standingModel || value.models.some(entry => entry.slug === result.resolvedModel));
  }
});
test('latest explicitly excludes luna even with a newer synthetic entry', () => {
  fallback(catalogue('gpt-99-luna'), 'luna', 'gpt-5.6-luna');
});
test('catalogue loader supports injected path reader and HOME', () => {
  const value = catalogue('gpt-6.1-terra');
  const readFile = (path, encoding) => {
    assert.equal(path, '/synthetic/.codex/models_cache.json');
    assert.equal(encoding, 'utf8');
    return JSON.stringify(value);
  };
  assert.deepEqual(loadCatalogue({ env: { HOME: '/synthetic' }, readFile }), value);
  assert.deepEqual(loadCatalogue({ path: '/synthetic/.codex/models_cache.json', readFile }), value);
});
test('catalogue loader converts missing unreadable and invalid JSON to fallback', () => {
  for (const readFile of [() => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); },
    () => { throw Object.assign(Error('unreadable'), { code: 'EACCES' }); }, () => '{']) {
    fallback(loadCatalogue({ path: '/synthetic/missing', readFile }));
  }
});
