import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { main, runPick, runLimit } from './model-routing.mjs';
import { classify } from '../scripts/classify.mjs';
import { readState, stateDirectory } from '../scripts/state.mjs';
import { loadPolicy } from '../scripts/policy.mjs';
import { installTestOverlay } from '../scripts/fixtures/with-test-repos.mjs';

function harness(t, extra = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pick-cli-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const output = [];
  const env = extra.withOverlay ? installTestOverlay(stateDir) : { HOME: stateDir };
  delete extra.withOverlay;
  return { stateDir, cwd: stateDir, env, repoKey: () => 'someone/repo', loadOverride: () => null,
    readQuota: () => null, stdout: text => output.push(text), stderr: text => output.push(text),
    now: '2026-10-04T15:35:00Z', output, ...extra };
}
function last(h) { return JSON.parse(h.output.at(-1)); }

test('CLI dry classification has code 3 and logs only brief hash and length', async t => {
  const h = harness(t); const brief = 'Fix the typo in the README';
  assert.equal(await main(['pick', '--brief', brief, '--json'], h), 3);
  assert.equal(last(h).reason, 'dry');
  const log = readFileSync(join(h.stateDir, 'decisions.jsonl'), 'utf8');
  assert.equal(log.trim().split('\n').length, 1); assert.ok(!log.includes(brief));
  assert.equal(JSON.parse(log).brief.sha256, createHash('sha256').update(brief).digest('hex'));
  assert.equal(JSON.parse(log).brief.length, brief.length);
});
test('CLI kind bypasses classifier even with execute; default quota read runs', async t => {
  let reads = 0;
  const h = harness(t, { classify: () => assert.fail('Jev call'), readQuota: () => { reads++; return null; } });
  assert.equal(await runPick(['--kind', 'quick-edit', '--execute', '--json'], h), 0);
  assert.equal(reads, 1); assert.equal(last(h).kindSource, 'flag');
  assert.deepEqual(last(h).spawn.missing, ['project', 'section', 'title', 'prompt-file']);
  assert.equal(await runPick(['--kind', 'quick-edit', '--no-quota'], h), 0); assert.equal(reads, 1);
});
test('CLI injects executing classifier and logs cost', async t => {
  const h = harness(t, { classify: async ({ execute, limitUsd, brief }) => {
    assert.equal(execute, true); assert.equal(limitUsd, 0.02); assert.equal(brief, 'a task');
    return { status: 'ok', kind: 'quick-edit', confidence: 0.8, top: [{ kind: 'quick-edit', p: 0.9 }], costUsd: 0.001 };
  } });
  assert.equal(await runPick(['--brief', 'a task', '--execute', '--jev-limit-usd', '0.02'], h), 0);
  assert.equal(last(h).kindSource, 'jev'); assert.equal(last(h).classifier.costUsd, 0.001);
});
test('two consecutive logged trials alternate, including concurrent commands', async t => {
  const h = harness(t);
  const args = ['--kind', 'multi-step-coding', '--no-quota', '--json'];
  await Promise.all([runPick(args, h), runPick(args, h)]);
  const logged = readFileSync(join(h.stateDir, 'decisions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(logged.map(d => d.basis), ['trial', 'trial']);
  assert.deepEqual(logged.map(d => d.route), ['sonnet', 'astra']);
  assert.equal(readState(h.stateDir).alternation['multi-step-coding'], 'astra');
});
test('three consecutive logged trials rotate Sonnet, Astra and Sol, then Sonnet again', async t => {
  const h = harness(t);
  const routes = [];
  for (let i = 0; i < 4; i++) {
    assert.equal(await runPick(['--kind', 'multi-step-coding', '--no-quota', '--json'], h), 0);
    routes.push([last(h).route, last(h).basis]);
  }
  assert.deepEqual(routes, [['sonnet', 'trial'], ['astra', 'trial'], ['sol', 'trial'], ['sonnet', 'trial']]);
  assert.deepEqual(readState(h.stateDir, loadPolicy()).poolAlternation['multi-step-coding'], { claude: 'sonnet', codex: 'sol' });
});
test('CLI limit persists cooldown and blocked decisions are logged with code 4', async t => {
  const h = harness(t);
  assert.equal(await runLimit(['muse'], h), 0);
  assert.equal(last(h).until, '2026-10-04T20:35:00.000Z');
  assert.equal(await runPick(['--kind', 'quick-edit'], h), 0); assert.equal(last(h).route, 'luna');
  await runLimit(['luna', '--hours', '1'], h);
  assert.equal(await runPick(['--kind', 'quick-edit'], h), 5); assert.equal(last(h).status, 'needs_approval');
  await runLimit(['opus'], h);
  assert.equal(await runPick(['--kind', 'architecture'], h), 4); assert.equal(last(h).status, 'blocked');
  const logged = readFileSync(join(h.stateDir, 'decisions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logged.at(-1).status, 'blocked');
});
test('external decision exits zero, preserves note and never has spawn arguments', async t => {
  const h = harness(t, { repoKey: () => 'acme/prelude-social-skills-coach', withOverlay: true });
  assert.equal(await runPick(['--kind', 'user-facing-copy'], h), 0);
  assert.equal(last(h).status, 'external'); assert.equal(last(h).spawn, undefined);
});
test('usage errors are code 2, validated before any external calls', async t => {
  const h = harness(t, { readQuota: () => assert.fail('usage must not read quota'), repoKey: () => assert.fail('usage must not call git') });
  for (const args of [['pick', '--kind', 'bogus'], ['pick', '--machine', 'bad'], ['pick', '--failures', '-1'],
    ['pick', '--failures', '1.5'], ['pick', '--brief', 'a', '--brief-file', 'x'], ['pick', '--jev-limit-usd', 'NaN'],
    ['pick', '--author', 'unknown'], ['pick', '--bogus'], ['limit', 'unknown'], ['limit', 'muse', '--hours', '0']]) {
    assert.equal(await main(args, h), 2, args.join(' '));
  }
});
test('brief files and exact spawn fields are passed through without executing anything', async t => {
  const h = harness(t, { readFile: () => 'file brief' });
  assert.equal(await runPick(['--kind', 'quick-edit', '--brief-file', '/tmp/brief', '--project', 'p', '--section', 's', '--title', 'fix typo', '--prompt-file', '/tmp/prompt with spaces'], h), 0);
  const d = last(h); assert.deepEqual(d.spawn.missing, []);
  assert.deepEqual(d.spawn.argv.slice(-4), ['--title', 'fix typo', '--prompt-file', '/tmp/prompt with spaces']);
});
test('state path precedence is override, XDG, home default', () => {
  assert.equal(stateDirectory({ MODEL_ROUTING_STATE_DIR: '/tmp/override', XDG_STATE_HOME: '/tmp/xdg' }), '/tmp/override');
  assert.equal(stateDirectory({ XDG_STATE_HOME: '/tmp/xdg' }), '/tmp/xdg/model-routing');
  assert.equal(stateDirectory({ HOME: '/tmp/home' }), '/tmp/home/.local/state/model-routing');
});

const measuredCard = model => ({ task: 'implementation', trust: 'CALIBRATED', generated: '2026-10-04', recommend: model });
function putCard(dir, model) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'implementation.card.json'), JSON.stringify(measuredCard(model)));
}
test('CLI card search order is flag, env, repo runs, then XDG data', async t => {
  const h = harness(t);
  const dirs = [join(h.stateDir, 'flag'), join(h.stateDir, 'env'), join(h.stateDir, 'repo', 'tasks', 'runs'), join(h.stateDir, 'data', 'model-routing', 'cards')];
  const models = ['anthropic/claude-sonnet-5.5', 'openai/gpt-6-astra', 'anthropic/claude-sonnet-5.5', 'openai/gpt-6-astra'];
  dirs.forEach((dir, i) => putCard(dir, models[i]));
  h.env = { HOME: h.stateDir, MODEL_ROUTING_CARDS_DIR: dirs[1], XDG_DATA_HOME: join(h.stateDir, 'data') };
  for (let i = 0; i < dirs.length; i++) {
    assert.equal(await runPick(['--kind', 'multi-step-coding', '--repo', join(h.stateDir, 'repo'), '--cards-dir', dirs[0], '--no-quota'], h), 0);
    assert.equal(last(h).basis, 'card'); assert.equal(last(h).route, i % 2 ? 'astra' : 'sonnet');
    rmSync(dirs[i], { recursive: true });
  }
});
test('global-install lookup finds a user XDG card with no package-relative card', async t => {
  const h = harness(t);
  const xdg = join(h.stateDir, '.local', 'share', 'model-routing', 'cards');
  putCard(xdg, 'openai/gpt-6-astra');
  assert.equal(existsSync(join(h.stateDir, 'tasks', 'runs', 'implementation.card.json')), false);
  assert.equal(await runPick(['--kind', 'multi-step-coding', '--no-quota'], h), 0);
  assert.equal(last(h).route, 'astra'); assert.equal(last(h).basis, 'card');
});
test('CLI ignores a card with the wrong task id and explains it', async t => {
  const h = harness(t); const cardsDir = join(h.stateDir, 'cards');
  putCard(cardsDir, 'openai/gpt-6-astra');
  const file = join(cardsDir, 'implementation.card.json');
  writeFileSync(file, JSON.stringify({ ...measuredCard('openai/gpt-6-astra'), task: 'quick-edit' }));
  await runPick(['--kind', 'multi-step-coding', '--cards-dir', cardsDir, '--no-quota'], h);
  assert.equal(last(h).basis, 'trial'); assert.match(last(h).why.join(' '), /card task mismatch/);
});
test('CLI reads a brief-file from disk without logging its text', async t => {
  const h = harness(t); const file = join(h.stateDir, 'brief.txt'); const brief = 'A private brief read from a file';
  writeFileSync(file, brief);
  assert.equal(await runPick(['--brief-file', file, '--no-quota'], h), 3);
  assert.equal(last(h).brief.sha256, createHash('sha256').update(brief).digest('hex'));
  assert.ok(!readFileSync(join(h.stateDir, 'decisions.jsonl'), 'utf8').includes(brief));
});
test('CLI readKey failure exits 2 with a clear diagnostic', async t => {
  const h = harness(t, { classify: (input, { policy }) => classify(input, { policy,
    readKey: () => { throw new Error('Configured Jev envFile could not be read or parsed.'); },
    fetchImpl: () => assert.fail('network after missing key') }) });
  assert.equal(await main(['pick', '--brief', 'task', '--execute', '--no-quota'], h), 2);
  assert.match(h.output.at(-1), /envFile could not be read/);
});
test('CLI notes corrupt lines, keeps full stdout argv, and excludes private spawn values from the log', async t => {
  const h = harness(t);
  writeFileSync(join(h.stateDir, 'decisions.jsonl'), 'broken line\n');
  const args = ['--kind', 'multi-step-coding', '--project', 'private-project', '--section', 'private-section',
    '--title', 'private title', '--prompt-file', '/private/prompt-path', '--no-quota'];
  await runPick(args, h);
  const d = last(h); assert.ok(d.notes.includes('skipped 1 unreadable log lines'));
  const text = readFileSync(join(h.stateDir, 'decisions.jsonl'), 'utf8');
  for (const value of ['private-project', 'private-section', 'private title', '/private/prompt-path']) {
    assert.ok(d.spawn.argv.includes(value)); assert.ok(!text.includes(value));
  }
  const logged = JSON.parse(text.trim().split('\n').at(-1)); assert.equal(logged.spawn.argv, undefined);
});
test('CLI require-quota blocks missing usage and displays the warning in human output', async t => {
  const h = harness(t);
  assert.equal(await main(['pick', '--kind', 'multi-step-coding', '--require-quota'], h), 4);
  assert.ok(last(h).notes.includes('quota unknown: hard stops not applied'));
  h.isTTY = true;
  await runPick(['--kind', 'multi-step-coding', '--no-quota'], h);
  assert.match(h.output.at(-1), /! quota unknown: hard stops not applied/);
});

test('CLI loads the local model from XDG without executing its beforeSpawn check', async t => {
  const h = harness(t);
  const configDir = join(h.stateDir, 'config');
  mkdirSync(join(configDir, 'model-routing'), { recursive: true });
  writeFileSync(join(configDir, 'model-routing', 'local.json'), JSON.stringify({ routes: { 'pi-local': { model: 'cli-local-fixture' } } }));
  h.env.XDG_CONFIG_HOME = configDir;
  assert.equal(await runPick(['--kind', 'bulk-text', '--no-quota'], h), 0);
  const d = last(h); assert.equal(d.model, 'cli-local-fixture');
  assert.equal(d.spawn.missing.includes('reasoning-level'), false);
  assert.match(d.beforeSpawn[0], /Check the local server is running/);
  h.isTTY = true;
  await runPick(['--kind', 'bulk-text', '--no-quota'], h);
  assert.match(h.output.at(-1), /before spawn: Check the local server/);
});
test('CLI accepts injected local config and rejects forbidden model overrides', async t => {
  const h = harness(t, { loadLocalConfig: () => ({ routes: { 'pi-local': { model: 'injected-fixture' } } }) });
  assert.equal(await runPick(['--kind', 'bulk-text', '--no-quota'], h), 0);
  assert.equal(last(h).route, 'pi-local');
  h.loadLocalConfig = () => ({ routes: { muse: { model: 'forbidden' } } });
  assert.equal(await main(['pick', '--kind', 'quick-edit', '--no-quota'], h), 2);
  assert.match(h.output.at(-1), /not marked modelFrom/);
});

test('CLI metered fallback exits 5 with preview only, then records explicit approval', async t => {
  const h = harness(t);
  await runLimit(['muse'], h); await runLimit(['luna'], h);
  const args = ['--kind', 'quick-edit', '--title', 'quoted title', '--json'];
  assert.equal(await main(['pick', ...args], h), 5);
  assert.equal(last(h).route, 'fw-deepseek-v4p1-flash');
  assert.equal(last(h).status, 'needs_approval');
  assert.equal(last(h).spawn, null);
  assert.ok(last(h).approval.spawnArgv.includes('quoted title'));
  assert.deepEqual(last(h).approval.costPer1M, { in: 0.3, out: 1.2 });
  assert.equal(last(h).approval.route, 'fw-deepseek-v4p1-flash');
  assert.deepEqual(last(h).costPer1M, { in: 0.3, out: 1.2 });
  assert.equal(await main(['pick', ...args, '--spend-approved', 'fw-deepseek-v4p1-flash'], h), 0);
  const rows = readFileSync(join(h.stateDir, 'decisions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(last(h).spawn.argv.includes('quoted title')); assert.equal(last(h).approval, undefined);
  assert.equal(rows[0].approval.spawnArgv, undefined);
  assert.ok(!JSON.stringify(rows).includes('quoted title'));
  assert.deepEqual(rows.map(d => d.spendApproved), [false, true]);
  assert.deepEqual(rows.map(d => d.status), ['needs_approval', 'ok']);
  assert.equal(await runPick([...args.filter(a => a !== '--json'), '--spend-approved', 'fw-deepseek-v4p1-flash'], { ...h, isTTY: true }), 0);
  assert.match(h.output.at(-1), /Cost per 1M tokens \(USD\): in 0.3, out 1.2; spend approved: true/);
});

test('malformed or invalid local config disables only local routes and reports its full path', async t => {
  const h = harness(t);
  const configDir = join(h.stateDir, 'config');
  const file = join(configDir, 'model-routing', 'local.json');
  mkdirSync(join(configDir, 'model-routing'), { recursive: true }); h.env.XDG_CONFIG_HOME = configDir;
  for (const contents of ['{"model": "private-value"', JSON.stringify({ routes: { muse: { model: 'private-value' } } })]) {
    writeFileSync(file, contents);
    assert.equal(await main(['pick', '--kind', 'multi-step-coding', '--no-quota'], h), 0);
    assert.equal(await main(['pick', '--kind', 'bulk-text', '--no-quota'], h), 0);
    const d = last(h); assert.equal(d.route, 'muse');
    assert.ok(d.alternatives.some(a => a.route === 'pi-local' && a.rejected.includes(file)));
    assert.ok(d.notes.includes('pi-local unavailable; falling back to muse (cloud). Do not send private text.'));
    assert.ok(!JSON.stringify(d).includes('private-value'));
  }
});
test('strict quota permits configured local work with no quota and logs its local model ID', async t => {
  const h = harness(t, { loadLocalConfig: () => ({ routes: { 'pi-local': { model: 'private-local-model' } } }) });
  assert.equal(await runPick(['--kind', 'bulk-text', '--require-quota', '--no-quota'], h), 0);
  assert.equal(last(h).route, 'pi-local'); assert.equal(last(h).model, 'private-local-model');
  assert.ok(readFileSync(join(h.stateDir, 'decisions.jsonl'), 'utf8').includes('private-local-model'));
});
test('named spend approval permits the explicit route with unknown prices', async t => {
  const h = harness(t, { loadOverride: () => ({ policyVersion: 1, rules: [
    { kinds: ['quick-edit'], route: 'fw-kimi-k3', source: 'fixture', why: 'explicit choice' },
  ] }) });
  assert.equal(await runPick(['--kind', 'quick-edit'], h), 5);
  assert.equal(last(h).spawn, null); assert.deepEqual(last(h).approval.costPer1M, { in: null, out: null });
  assert.equal(await runPick(['--kind', 'quick-edit', '--spend-approved', 'fw-kimi-k3'], h), 0);
  assert.ok(last(h).spawn.argv.includes('high')); assert.equal(last(h).reasoning, 'high');
});

test('approval is bound to named routes when the previous choice hits a cooldown', async t => {
  const h = harness(t);
  await runLimit(['muse'], h); await runLimit(['luna'], h);
  assert.equal(await runPick(['--kind', 'quick-edit'], h), 5);
  assert.equal(last(h).route, 'fw-deepseek-v4p1-flash');
  await runLimit(['fw-deepseek-v4p1-flash'], h);
  assert.equal(await runPick(['--kind', 'quick-edit', '--spend-approved', 'fw-deepseek-v4p1-flash'], h), 5);
  const d = last(h); assert.equal(d.route, 'fw-minimax-m3'); assert.equal(d.spawn, null);
  assert.ok(d.why.includes('approval covers fw-deepseek-v4p1-flash; selected fw-minimax-m3'));
  assert.equal(d.spendApproved, false); assert.deepEqual(d.approvedRoutes, ['fw-deepseek-v4p1-flash']);
  assert.equal(await runPick(['--kind', 'quick-edit', '--spend-approved', 'fw-deepseek-v4p1-flash,fw-minimax-m3'], h), 0);
  assert.equal(last(h).route, 'fw-minimax-m3'); assert.ok(last(h).spawn.argv);
  const rows = readFileSync(join(h.stateDir, 'decisions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.at(-1).approvedRoutes, ['fw-deepseek-v4p1-flash', 'fw-minimax-m3']);
  assert.equal(rows.at(-1).route, 'fw-minimax-m3');
});
test('approval syntax rejects bare, empty and unknown routes before any external reads', async t => {
  const h = harness(t, { repoKey: () => assert.fail('invalid flags must not read git'), readQuota: () => assert.fail('invalid flags must not read quota') });
  for (const args of [['--spend-approved'], ['--spend-approved', '--json'],
    ['--spend-approved', 'unknown'], ['--spend-approved', ','], ['--spend-approved', 'gemini-flash,']]) {
    assert.equal(await main(['pick', '--kind', 'quick-edit', ...args], h), 2);
    assert.match(h.output.at(-1), /name the approved route/);
  }
});
test('Prelude Gemini visual CLI requires approval for that route, leaving external copy unchanged', async t => {
  const h = harness(t, { repoKey: () => 'acme/prelude-social-skills-coach', withOverlay: true });
  const args = ['--kind', 'visual-implementation', '--no-quota'];
  assert.equal(await runPick(args, h), 5);
  assert.equal(last(h).route, 'gemini-flash'); assert.equal(last(h).provider, 'acp-gemini');
  assert.equal(last(h).reasoning, 'medium'); assert.equal(last(h).approval.costPer1M, null); assert.equal(last(h).spawn, null);
  assert.equal(await runPick([...args, '--spend-approved', 'gemini-pro'], h), 5);
  assert.equal(await runPick([...args, '--spend-approved', 'gemini-flash'], h), 0);
  assert.ok(last(h).spawn.argv.includes('acp-gemini'));
  assert.equal(await runPick(['--kind', 'user-facing-copy', '--spend-approved', 'gemini-flash'], h), 0);
  assert.equal(last(h).status, 'external'); assert.equal(last(h).route, 'gemini-copy');
});

function logged(h) { return readFileSync(join(h.stateDir, 'decisions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); }

test('escalated tier-1 pick then a normal tier-2 pick read the same log; both are logged', async t => {
  const h = harness(t);
  assert.equal(await runPick(['--kind', 'quick-edit', '--failures', '2', '--no-quota', '--json'], h), 0);
  const escalated = last(h);
  assert.equal(escalated.kind, 'quick-edit'); assert.equal(escalated.basis, 'trial');
  assert.equal(escalated.route, 'sonnet'); assert.match(escalated.why[0], /^tier 2 for quick-edit/);
  assert.equal(await runPick(['--kind', 'multi-step-coding', '--no-quota', '--json'], h), 0);
  const normal = last(h);
  // Alternation is per kind: the escalated quick-edit trial must not move multi-step-coding's turn.
  assert.equal(normal.kind, 'multi-step-coding'); assert.equal(normal.basis, 'trial');
  assert.equal(normal.route, 'sonnet'); assert.match(normal.why.join(' '), /last trial none/);
  const log = logged(h);
  assert.deepEqual(log.map(d => [d.kind, d.status, d.route, d.basis]),
    [['quick-edit', 'ok', 'sonnet', 'trial'], ['multi-step-coding', 'ok', 'sonnet', 'trial']]);
  assert.deepEqual(readState(h.stateDir, loadPolicy()).alternation, { 'quick-edit': 'sonnet', 'multi-step-coding': 'sonnet' });
});
test('escalated picks in between do not disturb a kind\'s own rotation', async t => {
  const h = harness(t);
  const run = async args => { assert.equal(await runPick([...args, '--no-quota', '--json'], h), 0); return last(h).route; };
  const seen = [];
  seen.push(await run(['--kind', 'multi-step-coding']));
  seen.push(await run(['--kind', 'quick-edit', '--failures', '2']));
  seen.push(await run(['--kind', 'quick-edit', '--failures', '2']));
  seen.push(await run(['--kind', 'multi-step-coding']));
  seen.push(await run(['--kind', 'multi-step-coding']));
  assert.deepEqual(seen, ['sonnet', 'sonnet', 'astra', 'astra', 'sol']);
  assert.equal(logged(h).length, 5);
});

test('the long test-plus-fix brief reaches the classifier whole, and the policy descriptions reach Jev', async t => {
  const brief = 'Add regression tests for pick\'s quota handling across scripts/pick.test.mjs and bin tests: both soft thresholds triggering at once, the alternative pool unavailable, and an escalated tier-1 task followed by a normal tier-2 pick read back through the CLI decision log. Fix any bug the tests expose in scripts/pick.mjs or scripts/state.mjs. Run npm test and open a PR.';
  const policy = loadPolicy(); const requests = [];
  // ⚠ Plumbing only: Jev's answer is mocked. scripts/classify.check.mjs checks the real classification.
  const fetchImpl = async (_, request) => {
    const body = JSON.parse(request.body); requests.push(body);
    const probabilities = Object.fromEntries(Object.keys(body.questions.kind.criteria).map(k => [k, k === 'hard-bug-fix' ? 0.75 : k === 'multi-step-coding' ? 0.25 : 0]));
    return { ok: true, json: async () => ({ answers: { kind: { type: 'choice', choice: 'hard-bug-fix', probabilities, confidence: 0.8 } }, usage: { input_tokens: 900 } }) };
  };
  const h = harness(t, { classify: (args, deps) => classify(args, { ...deps, fetchImpl, readKey: () => 'fixture' }) });
  assert.equal(await runPick(['--brief', brief, '--execute', '--no-quota', '--json'], h), 0);
  assert.equal(requests.length, 1); assert.equal(requests[0].state.brief, brief);
  const { criteria } = requests[0].questions.kind;
  assert.equal(criteria['write-tests'], policy.kinds['write-tests'].description);
  assert.match(criteria['write-tests'], /No product code changes/);
  const d = last(h);
  assert.equal(d.kind, 'hard-bug-fix'); assert.equal(d.kindSource, 'jev');
  assert.match(d.why[0], /^tier 2 for hard-bug-fix/); assert.ok(['sonnet', 'astra', 'sol'].includes(d.route));
  assert.deepEqual(d.classifier.top.slice(0, 2).map(v => v.kind), ['hard-bug-fix', 'multi-step-coding']);
  assert.ok(!readFileSync(join(h.stateDir, 'decisions.jsonl'), 'utf8').includes('regression tests'));
});
