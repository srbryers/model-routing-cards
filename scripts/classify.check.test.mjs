import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASES, CAP_USD, runCheck } from './classify.check.mjs';
import { loadPolicy } from './policy.mjs';
const policy = loadPolicy();

test('check list parses: briefs are unique, and every expected kind exists in the policy', () => {
  assert.ok(CASES.length >= 12);
  assert.equal(new Set(CASES.map(c => c.brief)).size, CASES.length);
  for (const { brief, expect } of CASES) {
    assert.ok(typeof brief === 'string' && brief.trim().length > 20);
    assert.ok(Array.isArray(expect) && expect.length > 0);
    for (const kind of expect) assert.ok(Object.hasOwn(policy.kinds, kind), `unknown kind ${kind}`);
  }
});
test('check list pins the four ambiguous briefs to one kind each', () => {
  const kindFor = pattern => CASES.find(c => pattern.test(c.brief)).expect;
  assert.deepEqual(kindFor(/do not know why/), ['hard-bug-fix']);
  assert.deepEqual(kindFor(/one line/), ['simple-bug-fix']);
  assert.deepEqual(kindFor(/iOS app. Tests only/), ['write-tests']);
  assert.deepEqual(kindFor(/React Router 7/), ['migration']);
});
test('check list covers the live brief and at least 8 other kinds', () => {
  const live = CASES.find(c => /both soft thresholds triggering at once/.test(c.brief));
  assert.deepEqual(live.expect, ['hard-bug-fix', 'multi-step-coding']);
  const others = new Set(CASES.filter(c => c !== live).flatMap(c => c.expect));
  assert.ok(others.size >= 8, [...others].join());
});
test('dry run makes no classifier call and reads no key', async () => {
  const lines = [];
  const result = await runCheck({ write: t => lines.push(t), classifyImpl: () => assert.fail('classifier call'),
    budget: () => assert.fail('budget') });
  assert.equal(result.executed, false); assert.match(lines.join(''), /pass --execute/);
});
test('execute preflights the whole run once, before any classification', async () => {
  const order = [];
  const answers = CASES.map(({ expect }, i) => i === 1
    ? { status: 'needs_kind', reason: 'low_probability', top: [{ kind: 'docs', p: 0.4 }], costUsd: 0.0002 }
    : { status: 'ok', kind: expect[0], top: [{ kind: expect[0], p: 0.9 }], costUsd: 0.0002 });
  let call = 0; const lines = [];
  const result = await runCheck({ execute: true, write: t => lines.push(t),
    budget: args => { order.push('budget'); assert.equal(args.limitUsd, CAP_USD); assert.ok(args.maxInputTokens > 0); return { reserveUsd: 0.001 }; },
    classifyImpl: async ({ execute, brief }) => { order.push('classify'); assert.equal(execute, true); assert.equal(brief, CASES[call].brief); return answers[call++]; } });
  assert.equal(order[0], 'budget'); assert.equal(order.filter(x => x === 'budget').length, 1);
  assert.equal(result.passed, CASES.length - 1); assert.equal(result.failed, 1);
  const text = lines.join('');
  assert.match(text, /expected\s+got\s+p\s+result/); assert.match(text, /docs \(low_probability\)\s+0\.40\s+FAIL/);
  assert.ok(result.spentUsd <= CAP_USD);
});
test('either expected kind passes for the live brief, and a refused budget stops everything', async () => {
  const one = [CASES[0]];
  const result = await runCheck({ cases: one, execute: true, write: () => {}, budget: () => ({ reserveUsd: 0 }),
    classifyImpl: async () => ({ status: 'ok', kind: 'multi-step-coding', top: [{ kind: 'multi-step-coding', p: 0.7 }], costUsd: null }) });
  assert.equal(result.passed, 1); assert.equal(result.spentUsd, CAP_USD);
  await assert.rejects(runCheck({ execute: true, write: () => {}, budget: () => { throw new Error('Jev budget refused'); },
    classifyImpl: () => assert.fail('call after refusal') }), /budget refused/);
});
