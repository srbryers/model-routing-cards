import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, runPick } from './model-routing.mjs';
import { logDecision } from '../scripts/state.mjs';
import { buildCard } from '../scripts/card.mjs';
import { loadPolicy } from '../scripts/policy.mjs';
import { assertJevBudget, fitJevState } from '../scripts/jev.mjs';

const brief = 'PRIVATE BRIEF: fix the parser';
const resultText = 'PRIVATE RESULT: parser fixed';
function harness(t, extra = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'outcomes-cli-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const output = [];
  return { stateDir, now: '2026-10-04T18:00:00Z', output,
    stdout: text => output.push(text), stderr: text => output.push(text),
    readKey: () => assert.fail('credential read'), fetchImpl: () => assert.fail('network call'),
    ...extra };
}
const last = h => JSON.parse(h.output.at(-1));
const log = h => readFileSync(join(h.stateDir, 'outcomes.jsonl'), 'utf8');
function decision(h, extra = {}, text = brief) {
  return logDecision(h.stateDir, { id: 'dec_test', at: h.now, status: 'ok', kind: 'quick-edit',
    route: 'muse', basis: 'policy', repo: 'someone/repo', ...extra }, text);
}
function files(h, text = brief, result = resultText) {
  const b = join(h.stateDir, 'brief.txt'), r = join(h.stateDir, 'result.txt');
  writeFileSync(b, text); writeFileSync(r, result);
  return ['--brief-file', b, '--result-file', r];
}
const record = ['record', 'dec_test', '--result', 'pass'];
const response = (body = { answers: { metBrief: { noul: 0.91 } }, model: 'jev-test', usage: { input_tokens: 1000 } }) => ({ ok: true, json: async () => body });

test('record stores verified facts and copies decision metadata', async t => {
  const h = harness(t); const d = decision(h);
  const f = join(h.stateDir, 'gates.json'); writeFileSync(f, JSON.stringify({ lint: 'pass' }));
  assert.equal(await main([...record, '--gate', 'tests=pass', '--gate', 'typecheck=fail',
    '--gates-file', f, '--failures-before', '2', '--notes', 'Verified by main thread'], h), 0);
  assert.deepEqual(last(h), { decisionId: d.id, at: '2026-10-04T18:00:00.000Z',
    kind: d.kind, route: d.route, basis: d.basis, repo: d.repo, result: 'pass',
    gates: { lint: 'pass', tests: 'pass', typecheck: 'fail' }, failuresBefore: 2, notes: 'Verified by main thread' });
  assert.deepEqual(JSON.parse(log(h)), last(h));
});

test('unknown decision exits 2 without appending or requesting Jev', async t => {
  const h = harness(t);
  assert.equal(await main([...record, ...files(h), '--execute'], h), 2);
  assert.match(h.output.at(-1), /Unknown decision id/);
  assert.equal(existsSync(join(h.stateDir, 'outcomes.jsonl')), false);
});

test('decisions without a route cannot record outcomes', async t => {
  const h = harness(t); decision(h, { status: 'blocked', route: undefined, basis: undefined });
  assert.equal(await main(record, h), 2);
  assert.match(h.output.at(-1), /did not select a route/);
});

test('brief mismatch or absent decision hash refuses before budget, key or request', async t => {
  const h = harness(t, { budget: () => assert.fail('budget before hash') });
  decision(h);
  assert.equal(await main([...record, ...files(h, 'different brief'), '--execute'], h), 2);
  assert.match(h.output.at(-1), /hash does not match/);
  logDecision(h.stateDir, { id: 'hashless', kind: 'quick-edit', route: 'muse', basis: 'policy' });
  assert.equal(await main(['record', 'hashless', '--result', 'pass', ...files(h), '--execute'], h), 2);
  assert.match(h.output.at(-1), /hash does not match/);
  assert.equal(existsSync(join(h.stateDir, 'outcomes.jsonl')), false);
});

test('without execute, neither Jev nor its budget, credentials or text files are read', async t => {
  const h = harness(t, { budget: () => assert.fail('budget'), readFile: () => assert.fail('text file read') });
  decision(h);
  assert.equal(await main([...record, '--brief-file', 'missing', '--result-file', 'missing'], h), 0);
  assert.equal(last(h).jev, undefined);
  assert.equal(await main([...record, '--brief-file', 'missing'], h), 0);
});

test('execute requires both files', async t => {
  const h = harness(t); decision(h);
  for (const args of [[], ['--brief-file', 'x'], ['--result-file', 'x']]) {
    assert.equal(await main([...record, ...args, '--execute'], h), 2);
    assert.match(h.output.at(-1), /requires --brief-file and --result-file/);
  }
});

test('one injected Noul follows budget and key, stores only probability, model and cost', async t => {
  const order = [];
  const h = harness(t, {
    budget: options => { order.push('budget'); assert.deepEqual(options, { limitUsd: 0.02, maxRequests: 1 }); assertJevBudget(options); },
    readKey: () => { order.push('key'); return 'test-key'; },
    fetchImpl: async (url, options) => {
      order.push('request');
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      const body = JSON.parse(options.body);
      assert.deepEqual(body.questions, { metBrief: { type: 'noul', instructions: 'Does the result meet the brief?' } });
      assert.equal(body.model, 'jev-latest');
      assert.deepEqual(JSON.parse(body.state), { brief, result: resultText });
      return response();
    },
  });
  decision(h);
  assert.equal(await main([...record, ...files(h), '--execute', '--jev-limit-usd', '0.02'], h), 0);
  assert.deepEqual(order, ['budget', 'key', 'request']);
  assert.deepEqual(last(h).jev, { metBrief: 0.91, model: 'jev-test', costUsd: 0.000042 });
  for (const text of [brief, resultText, 'test-key', 'answers', 'input_tokens']) assert.ok(!log(h).includes(text));
  assert.deepEqual(last(h).gates, {}); // Jev never supplies factual gates.
});

test('budget refusal prevents credential and request reads', async t => {
  const h = harness(t); decision(h);
  assert.equal(await main([...record, ...files(h), '--execute', '--jev-limit-usd', '0'], h), 2);
  assert.match(h.output.at(-1), /Jev budget refused/);
  assert.equal(existsSync(join(h.stateDir, 'outcomes.jsonl')), false);
});

test('Jev state uses the existing truncation limit', async t => {
  const longResult = resultText.repeat(6000);
  const h = harness(t, { readKey: () => 'test', fetchImpl: async (_, options) => {
    const state = JSON.parse(options.body).state;
    assert.equal(state, fitJevState({ brief, result: longResult }));
    assert.ok(state.length <= 80_000); assert.match(state, /chars omitted/);
    return response();
  } });
  decision(h);
  assert.equal(await main([...record, ...files(h, brief, longResult), '--execute'], h), 0);
  assert.ok(!log(h).includes(resultText));
});

test('Jev errors are private and do not append an outcome', async t => {
  const h = harness(t, { readKey: () => 'test', fetchImpl: async () => { throw new Error(brief + resultText); } });
  decision(h);
  assert.equal(await main([...record, ...files(h), '--execute'], h), 2);
  assert.match(h.output.at(-1), /Jev brief check failed/);
  assert.ok(!h.output.join('').includes(brief));
  assert.equal(existsSync(join(h.stateDir, 'outcomes.jsonl')), false);
});

test('invalid Jev probabilities are refused; missing cost stays unknown', async t => {
  const h = harness(t, { readKey: () => 'test' }); decision(h); const f = files(h);
  for (const p of [undefined, null, '0.9', -0.1, 1.1]) {
    h.fetchImpl = async () => response({ answers: { metBrief: { noul: p } } });
    assert.equal(await main([...record, ...f, '--execute'], h), 2);
    assert.match(h.output.at(-1), /invalid probability/);
  }
  h.fetchImpl = async () => response({ answers: { metBrief: { noul: 0 } } });
  assert.equal(await main([...record, ...f, '--execute'], h), 0);
  assert.deepEqual(last(h).jev, { metBrief: 0, model: null, costUsd: null });
});

test('record validates result, gates, notes, failure count and budget', async t => {
  const h = harness(t); decision(h);
  for (const args of [[], ['--result', 'unknown'], ['--result', 'pass', '--gate', 'tests=true'],
    ['--result', 'pass', '--gate', 'tests=pass', '--gate', 'tests=fail'],
    ['--result', 'pass', '--notes', 'a'.repeat(501)], ['--result', 'pass', '--failures-before', '-1'],
    ['--result', 'pass', '--failures-before', '1.5'], ['--result', 'pass', '--jev-limit-usd', 'NaN']]) {
    assert.equal(await main(['record', 'dec_test', ...args], h), 2);
  }
  const f = join(h.stateDir, 'gates.json');
  for (const gates of [null, [], { tests: true }, { '': 'pass' }]) {
    writeFileSync(f, JSON.stringify(gates));
    assert.equal(await main([...record, '--gates-file', f], h), 2);
  }
  writeFileSync(f, '{"tests":"fail"}');
  assert.equal(await main([...record, '--gates-file', f, '--gate', 'tests=pass'], h), 2);
  assert.equal(await main([...record, '--notes', '🙂'.repeat(500)], h), 0);
});

test('re-record uses latest appended line, not timestamp; basis counts remain per decision', async t => {
  const h = harness(t); decision(h);
  assert.equal(await main(record, h), 0);
  h.now = '2026-10-03T18:00:00Z';
  assert.equal(await main(['record', 'dec_test', '--result', 'partial'], h), 0);
  assert.equal(log(h).trim().split('\n').length, 2);
  assert.equal(await main(['outcomes', '--json'], h), 0);
  const row = last(h).rows[0];
  assert.equal(row.decisions, 1); assert.equal(row.recordedOutcomes, 1);
  assert.equal(row.pass, 0); assert.equal(row.partial, 1);
  assert.deepEqual(row.outcomeBasis, { trial: 0, policy: 1, card: 0, 'card-cheaper': 0 });
});

test('readiness needs enough outcomes on each route, regardless of result; kind filter and task mapping', async t => {
  const h = harness(t);
  for (const kind of ['multi-step-coding', 'quick-edit']) {
    for (const route of ['astra', 'sonnet']) {
      for (let i = 0; i < 5; i++) {
        const id = `${kind}_${route}_${i}`;
        decision(h, { id, kind, route, basis: i % 2 ? 'trial' : 'policy' });
        if (kind === 'quick-edit' && route === 'sonnet' && i === 4) continue;
        assert.equal(await main(['record', id, '--result', ['pass', 'partial', 'fail', 'abandoned', 'pass'][i]], h), 0);
      }
    }
  }
  assert.equal(await main(['outcomes', '--json'], h), 0);
  const summary = last(h);
  assert.equal(summary.label, 'field outcomes — not a comparison');
  assert.deepEqual(summary.thresholds, { minOutcomesPerRoute: 5, minRoutes: 2 });
  assert.deepEqual(summary.readiness.map(r => [r.kind, r.ready]), [['multi-step-coding', true], ['quick-edit', false]]);
  assert.match(summary.readiness[0].nextStep, /model-routing run tasks\/implementation.mjs --execute/);
  assert.equal(summary.readiness[0].card, loadPolicy().cards.byKind['multi-step-coding']);
  assert.equal(summary.rows[0].abandoned, 1);
  assert.equal(await main(['outcomes'], h), 0);
  assert.match(h.output.at(-1), /field outcomes — not a comparison/);
  assert.match(h.output.at(-1), /multi-step-coding: ready for a bake-off/);
  assert.match(h.output.at(-1), /quick-edit: not ready for a bake-off/);
  assert.doesNotMatch(h.output.at(-1), /winner|recommend|pass.rate/i);
  assert.equal(await main(['outcomes', '--kind', 'quick-edit', '--json'], h), 0);
  assert.equal(last(h).rows.length, 2); assert.equal(last(h).readiness.length, 1);
  assert.equal(await main(['outcomes', '--kind', 'invalid'], h), 2);
});

test('empty history and unmapped ready kind have actionable output', async t => {
  const h = harness(t, { loadPolicy: () => ({ ...loadPolicy(), fieldEvidence: { minOutcomesPerRoute: 1, minRoutes: 2 } }) });
  assert.equal(await main(['outcomes'], h), 0); assert.match(h.output.at(-1), /No decisions recorded/);
  assert.equal(await main(['outcomes', '--kind', 'docs', '--json'], h), 0);
  assert.deepEqual(last(h).rows, []); assert.equal(last(h).readiness[0].ready, false);
  for (const route of ['muse', 'luna']) {
    decision(h, { id: route, route, kind: 'docs' });
    assert.equal(await main(['record', route, '--result', 'fail'], h), 0);
  }
  assert.equal(await main(['outcomes', '--json'], h), 0);
  assert.match(last(h).readiness[0].nextStep, /map cards.byKind\["docs"\] to tasks\/runs\/docs.card.json/);
});

test('concurrent records append intact lines using the shared state lock', async t => {
  const h = harness(t); decision(h);
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => main(record, h))), [0, 0, 0, 0, 0]);
  assert.equal(log(h).trim().split('\n').map(JSON.parse).length, 5);
  assert.equal(existsSync(join(h.stateDir, '.lock')), false);
});

test('field outcomes never enter card, route or pick trust inputs', async t => {
  const h = harness(t, { repoKey: () => null, loadOverride: () => null });
  const receipts = ['a', 'b'].flatMap(model => Array.from({ length: 3 }, () => ({ model,
    state: 'completed', gates_passed: true, metrics: { score: model === 'a' ? 1 : 0.5 }, cost_usd: 0.001 })));
  const options = { taskId: 'test', today: new Date(h.now) };
  const before = buildCard(receipts, options);
  assert.equal(await runPick(['--kind', 'quick-edit', '--no-quota', '--json'], h), 0);
  const pickBefore = last(h);
  // ⚠ Invalid JSON makes an accidental field-evidence read fail visibly.
  writeFileSync(join(h.stateDir, 'outcomes.jsonl'), 'THIS IS NOT JSON');
  assert.deepEqual(buildCard(receipts, options), before);
  assert.equal(await runPick(['--kind', 'quick-edit', '--no-quota', '--json'], h), 0);
  const pickAfter = last(h);
  delete pickBefore.id; delete pickAfter.id;
  assert.deepEqual(pickAfter, pickBefore);
  for (const file of ['card', 'route', 'pick', 'state']) {
    assert.doesNotMatch(readFileSync(new URL(`../scripts/${file}.mjs`, import.meta.url), 'utf8'), /outcomes|recordOutcome|fieldEvidence/);
  }
  assert.doesNotMatch(runPick.toString(), /outcomes|recordOutcome|fieldEvidence/);
});
