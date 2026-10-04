import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, runOutcomes } from './model-routing.mjs';
import { logDecision } from '../scripts/state.mjs';
import { buildCard } from '../scripts/card.mjs';
import { loadPolicy } from '../scripts/policy.mjs';
import { assertJevBudget } from '../scripts/jev.mjs';

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
      assert.deepEqual(body.state, { brief, result: resultText });
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

test('key configuration errors stay actionable after budget approval, before a request', async t => {
  let approved = false;
  const h = harness(t, { budget: () => { approved = true; }, readKey: () => {
    assert.equal(approved, true);
    throw new Error('No Jev key configured');
  } });
  decision(h);
  assert.equal(await main([...record, ...files(h), '--execute'], h), 2);
  assert.match(h.output.at(-1), /No Jev key configured/);
  assert.equal(existsSync(join(h.stateDir, 'outcomes.jsonl')), false);
});

test('a 90000-character result keeps the entire brief and both ends of the result', async t => {
  const longResult = 'HEAD' + 'x'.repeat(89_992) + 'TAIL';
  const h = harness(t, { readKey: () => 'test', fetchImpl: async (_, options) => {
    const state = JSON.parse(options.body).state;
    assert.equal(state.brief, brief);
    assert.ok(state.brief.length + state.result.length <= 80_000);
    assert.ok(state.result.length > 48_000); // The short brief leaves its unused share available.
    assert.match(state.result, /^HEADx+\[… \d+ chars omitted …\]x+TAIL$/);
    const omitted = Number(state.result.match(/\[… (\d+) chars omitted …\]/)[1]);
    assert.equal(state.result.replace(/\[… \d+ chars omitted …\]/, '').length + omitted, longResult.length);
    return response();
  } });
  decision(h);
  assert.equal(await main([...record, ...files(h, brief, longResult), '--execute'], h), 0);
  assert.ok(!log(h).includes('HEAD'));
});

test('a brief larger than its 40 percent share is refused before budget or credentials', async t => {
  const h = harness(t, { budget: () => assert.fail('budget before brief-size check') });
  const oversized = 'b'.repeat(32_001);
  decision(h, {}, oversized);
  assert.equal(await main([...record, ...files(h, oversized), '--execute'], h), 2);
  assert.equal(h.output.at(-1), 'brief too large to judge\n');
  assert.equal(existsSync(join(h.stateDir, 'outcomes.jsonl')), false);
});

test('a brief exactly at its share remains intact with a truncated result', async t => {
  const fullBrief = 'b'.repeat(32_000);
  const h = harness(t, { readKey: () => 'test', fetchImpl: async (_, options) => {
    const state = JSON.parse(options.body).state;
    assert.equal(state.brief, fullBrief);
    assert.ok(state.result.length <= 48_000);
    return response();
  } });
  decision(h, {}, fullBrief);
  assert.equal(await main([...record, ...files(h, fullBrief, 'r'.repeat(90_000)), '--execute'], h), 0);
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
  assert.match(last(h).readiness[0].nextStep, /map cards.byKind\["docs"\] to docs.card.json/);
});

test('concurrent records append intact lines using the shared state lock', async t => {
  const h = harness(t); decision(h);
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => main(record, h))), [0, 0, 0, 0, 0]);
  assert.equal(log(h).trim().split('\n').map(JSON.parse).length, 5);
  assert.equal(existsSync(join(h.stateDir, '.lock')), false);
});

test('valid adverse field outcomes cannot change pick or receipt cards, and are never opened', async t => {
  const h = harness(t);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const repo = join(h.stateDir, 'repo');
  const runs = join(repo, 'runs');
  mkdirSync(join(runs, 'quick-edit'), { recursive: true });
  const task = join(repo, 'task.mjs');
  writeFileSync(task, "export const task = { id: 'quick-edit', models: ['a', 'b'], prompt: () => '', score: () => ({}) };\n");
  const receipts = ['meta/muse-spark-1.3', 'openai/gpt-6-luna'].flatMap((model, m) =>
    Array.from({ length: 3 }, () => ({ model, state: 'completed', gates_passed: true,
      metrics: { score: m === 0 ? 1 : 0.5 }, cost_usd: 0.001 })));
  receipts.forEach((r, i) => writeFileSync(join(runs, 'quick-edit', `${i}.json`), JSON.stringify(r)));
  const outcomePath = join(h.stateDir, 'outcomes.jsonl');
  const openedPath = join(h.stateDir, 'opened.txt');
  const preload = join(h.stateDir, 'tripwire.cjs');
  // ⚠ A thrown read can be swallowed. Record every attempt outside the process as well.
  writeFileSync(preload, `
    const fs = require('node:fs');
    const { resolve } = require('node:path');
    const { fileURLToPath } = require('node:url');
    const guard = path => {
      if (path instanceof URL) path = fileURLToPath(path);
      if (Buffer.isBuffer(path)) path = path.toString();
      if (typeof path === 'string' && resolve(path) === process.env.TEST_OUTCOME_PATH) {
        fs.appendFileSync(process.env.TEST_OUTCOME_OPEN_LOG, 'opened\\n');
        throw new Error('Outcome read tripwire');
      }
    };
    for (const key of ['readFileSync', 'openSync', 'readFile', 'open', 'createReadStream']) {
      const original = fs[key];
      fs[key] = function(path, ...args) { guard(path); return original.call(this, path, ...args); };
    }
    for (const key of ['readFile', 'open']) {
      const original = fs.promises[key];
      fs.promises[key] = async function(path, ...args) { guard(path); return original.call(this, path, ...args); };
    }
    require('node:module').syncBuiltinESMExports();
  `);
  const env = { ...process.env, MODEL_ROUTING_STATE_DIR: h.stateDir,
    MODEL_ROUTING_CARDS_DIR: runs, XDG_DATA_HOME: join(h.stateDir, 'data'),
    TEST_OUTCOME_PATH: outcomePath, TEST_OUTCOME_OPEN_LOG: openedPath };
  const invoke = args => spawnSync(process.execPath, ['--require', preload, ...args], { env, encoding: 'utf8' });
  const probe = invoke(['-e', "require('node:fs').readFileSync(process.env.TEST_OUTCOME_PATH)"]);
  assert.notEqual(probe.status, 0);
  assert.equal(readFileSync(openedPath, 'utf8').trim(), 'opened');
  rmSync(openedPath);
  const cardArgs = [join(root, 'scripts', 'route.mjs'), 'card', task];
  const pickArgs = [join(root, 'bin', 'model-routing.mjs'), 'pick', '--kind', 'quick-edit',
    '--repo', repo, '--cards-dir', runs, '--no-quota', '--json'];
  const beforeCard = invoke(cardArgs);
  assert.equal(beforeCard.status, 0, beforeCard.stderr);
  const cardPath = join(runs, 'quick-edit.card.json');
  const cardBytes = readFileSync(cardPath, 'utf8');
  const beforePick = invoke(pickArgs);
  assert.equal(beforePick.status, 0, beforePick.stderr);
  const selected = JSON.parse(beforePick.stdout);
  assert.equal(selected.route, 'muse');
  const outcomes = [];
  for (const route of [selected.route, 'luna']) {
    for (let i = 0; i < 10; i++) {
      const d = decision(h, { id: `${route}_${i}`, route });
      outcomes.push({ decisionId: d.id, at: d.at, kind: d.kind, route, basis: d.basis,
        repo: d.repo, result: route === selected.route ? 'fail' : 'pass', gates: {}, failuresBefore: 0, notes: '' });
    }
  }
  writeFileSync(outcomePath, outcomes.map(o => JSON.stringify(o)).join('\n') + '\n');
  assert.equal(await main(['outcomes', '--json'], h), 0);
  assert.equal(last(h).readiness[0].ready, true);
  assert.equal(last(h).rows.find(r => r.route === selected.route).fail, 10);
  const pureBefore = buildCard(receipts, { taskId: 'quick-edit', today: new Date(h.now) });
  const afterPick = invoke(pickArgs);
  assert.equal(afterPick.status, 0, afterPick.stderr);
  const after = JSON.parse(afterPick.stdout);
  for (const d of [selected, after]) { delete d.id; delete d.at; }
  assert.deepEqual(after, selected);
  const afterCard = invoke(cardArgs);
  assert.equal(afterCard.status, 0, afterCard.stderr);
  assert.equal(afterCard.stdout, beforeCard.stdout);
  assert.equal(readFileSync(cardPath, 'utf8'), cardBytes);
  assert.deepEqual(buildCard(receipts, { taskId: 'quick-edit', today: new Date(h.now) }), pureBefore);
  assert.equal(existsSync(openedPath), false, 'pick/card attempted to open the outcomes file');
});

test('only record and outcomes production code names the outcomes log', () => {
  // ⚠ Check every production module, including transitive and future helper imports.
  for (const directory of ['bin', 'scripts']) {
    const root = new URL(`../${directory}/`, import.meta.url);
    for (const name of readdirSync(root, { recursive: true })) {
      if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
      let source = readFileSync(new URL(name, root), 'utf8');
      if (directory === 'scripts' && name === 'outcomes.mjs') continue;
      if (directory === 'bin' && name === 'model-routing.mjs') source = source.replace(runOutcomes.toString(), '');
      assert.doesNotMatch(source, /outcomes\.jsonl/, `${directory}/${name} opens field evidence outside record/outcomes`);
    }
  }
});

test('shared log helpers skip corrupt lines and preserve appends after a truncated tail', async t => {
  const h = harness(t); decision(h);
  const decisionFile = join(h.stateDir, 'decisions.jsonl');
  writeFileSync(decisionFile, readFileSync(decisionFile, 'utf8') + 'null\n{broken');
  const outcomeFile = join(h.stateDir, 'outcomes.jsonl');
  writeFileSync(outcomeFile, '[]\n{broken');
  assert.equal(await main(record, h), 0);
  assert.equal(await main(['outcomes', '--json'], h), 0);
  assert.equal(last(h).rows[0].recordedOutcomes, 1);
  assert.equal(last(h).rows[0].pass, 1);
  assert.deepEqual(last(h).unreadableLogLines, { decisions: 2, outcomes: 2 });
  assert.equal(await main(['outcomes'], h), 0);
  assert.match(h.output.at(-1), /Skipped 2 unreadable outcomes log lines/);
});
