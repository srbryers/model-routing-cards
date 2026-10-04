import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { main, runPick, runLimit } from './model-routing.mjs';
import { readState, stateDirectory } from '../scripts/state.mjs';

function harness(t, extra = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pick-cli-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const output = [];
  return { stateDir, repoKey: () => 'someone/repo', loadOverride: () => null,
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
test('CLI limit persists cooldown and blocked decisions are logged with code 4', async t => {
  const h = harness(t);
  assert.equal(await runLimit(['muse'], h), 0);
  assert.equal(last(h).until, '2026-10-04T20:35:00.000Z');
  assert.equal(await runPick(['--kind', 'quick-edit'], h), 0); assert.equal(last(h).route, 'luna');
  await runLimit(['luna', '--hours', '1'], h);
  assert.equal(await runPick(['--kind', 'quick-edit'], h), 4); assert.equal(last(h).status, 'blocked');
  const logged = readFileSync(join(h.stateDir, 'decisions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logged.at(-1).status, 'blocked');
});
test('external decision exits zero, preserves note and never has spawn arguments', async t => {
  const h = harness(t, { repoKey: () => 'srbryers/prelude-social-skills-coach' });
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
