import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './classify.mjs';
import { loadPolicy } from './policy.mjs';
import { assertJevBudget } from './jev.mjs';
const policy = loadPolicy();
function dependencies(probabilities, extra = {}) {
  return { policy, readKey: () => 'test-fixture', fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(request.body);
    assert.deepEqual(body.state, { brief: 'fix typo' });
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.questions.kind.type, 'choice');
    for (const [kind, value] of Object.entries(policy.kinds)) assert.equal(body.questions.kind.criteria[kind], value.description);
    const full = Object.fromEntries(Object.keys(body.questions.kind.criteria).map(k => [k, probabilities[k] ?? 0]));
    return { ok: true, json: async () => ({ answers: { kind: { type: 'choice',
      choice: Object.keys(full).sort((a, b) => full[b] - full[a])[0], probabilities: full, confidence: 0.7 } }, usage: { input_tokens: 1000 } }) };
  }, ...extra };
}
const input = { brief: 'fix typo', execute: true };
test('confident classification preserves probabilities and measured cost', async () => {
  const answer = await classify(input, dependencies({ 'quick-edit': 0.8, docs: 0.2 }));
  assert.equal(answer.status, 'ok'); assert.equal(answer.kind, 'quick-edit');
  assert.equal(answer.confidence, 0.7); assert.equal(answer.costUsd, 0.000042);
  assert.deepEqual(answer.top.slice(0, 2), [{ kind: 'quick-edit', p: 0.8 }, { kind: 'docs', p: 0.2 }]);
});
test('low probability returns three ranked kinds', async () => {
  const answer = await classify(input, dependencies({ 'quick-edit': 0.5, docs: 0.3, scouting: 0.2 }));
  assert.equal(answer.status, 'needs_kind'); assert.equal(answer.reason, 'low_probability');
  assert.deepEqual(answer.top.map(v => v.kind), ['quick-edit', 'docs', 'scouting']);
});
test('small margin returns needs_kind independently of minimum probability', async () => {
  // ⚠ With a 0.6 minimum, normalized probabilities already imply a gap of at least 0.2.
  const custom = structuredClone(policy); custom.classifier.minProbability = 0.4;
  const answer = await classify(input, dependencies({ 'quick-edit': 0.51, docs: 0.49 }, { policy: custom }));
  assert.equal(answer.status, 'needs_kind'); assert.equal(answer.reason, 'small_margin');
});
test('unknown answer retains top three real kinds without assigning a route', async () => {
  const answer = await classify(input, dependencies({ unknown: 0.7, docs: 0.2, 'quick-edit': 0.1 }));
  assert.equal(answer.status, 'needs_kind'); assert.equal(answer.reason, 'unknown');
  assert.equal(answer.top.length, 3); assert.ok(answer.top.every(v => v.kind !== 'unknown'));
});
test('budget preflight happens before credentials and request; refusal prevents both', async () => {
  const order = [];
  await classify(input, dependencies({ docs: 1 }, { budget: value => { order.push('budget'); assertJevBudget(value); },
    readKey: () => { order.push('key'); return 'fixture'; }, fetchImpl: async () => { order.push('fetch'); return { ok: false }; } }));
  assert.deepEqual(order, ['budget', 'key', 'fetch']);
  await assert.rejects(classify({ ...input, limitUsd: 0 }, dependencies({}, {
    readKey: () => assert.fail('key read'), fetchImpl: () => assert.fail('network'),
  })), /budget refused/);
});
test('dry classification reads no credentials and makes no request', async () => {
  const nope = () => assert.fail('dry side effect');
  const answer = await classify({ brief: 'fix typo' }, { policy, budget: nope, readKey: nope, fetchImpl: nope });
  assert.equal(answer.reason, 'dry'); assert.equal(answer.costUsd, 0);
});
test('malformed response, errors and missing usage never invent evidence or leak text', async () => {
  for (const fetchImpl of [async () => ({ ok: true, json: async () => ({}) }),
    async () => { throw Error('secret brief and fixture-key'); },
    async () => ({ ok: true, json: async () => { throw Error('secret brief'); } })]) {
    const answer = await classify(input, dependencies({}, { fetchImpl }));
    assert.equal(answer.status, 'needs_kind'); assert.equal(answer.costUsd, null);
    assert.doesNotMatch(JSON.stringify(answer), /secret|fixture-key/);
  }
});

test('key errors propagate before a request instead of becoming classifier_unavailable', async () => {
  await assert.rejects(classify(input, dependencies({}, { readKey: () => { throw Error('Configured Jev envFile could not be read'); },
    fetchImpl: () => assert.fail('request after key error') })), /envFile could not be read/);
});
test('UTF-8 byte count bounds tokens in the budget preflight', async () => {
  const brief = '界'.repeat(22_000);
  let tokens;
  await classify({ brief, execute: true }, { policy, budget: args => { tokens = args.maxInputTokens; assertJevBudget(args); },
    readKey: () => 'fixture', fetchImpl: async (_, request) => {
      assert.equal(tokens, Buffer.byteLength(request.body)); assert.ok(tokens > 64_000); return { ok: false };
    } });
  await assert.rejects(classify({ brief, execute: true, limitUsd: 0.0027 }, { policy,
    readKey: () => assert.fail('budget must reject before key'), fetchImpl: () => assert.fail('network') }), /budget refused/);
  await assert.rejects(classify({ brief: '界'.repeat(30_000), execute: true }, { policy,
    budget: () => assert.fail('oversized input before budget') }), /80000 bytes/);
});
