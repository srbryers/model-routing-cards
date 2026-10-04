import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { withStateLock, readState, logDecision } from './state.mjs';
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'routing-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
function lock(dir, pid, at) {
  mkdirSync(join(dir, '.lock'));
  writeFileSync(join(dir, '.lock', 'owner.json'), JSON.stringify({ pid, at }));
}
test('dead PID and locks older than 30 seconds are reclaimed', async t => {
  const dir = temp(t);
  const child = fork(new URL('./fixtures/lock-owner.mjs', import.meta.url), ['exit'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  await once(child, 'exit');
  for (const [pid, at] of [[child.pid, new Date().toISOString()], [process.pid, new Date(Date.now() - 31_000).toISOString()]]) {
    lock(dir, pid, at);
    await withStateLock(dir, () => {
      const owner = JSON.parse(readFileSync(join(dir, '.lock', 'owner.json'), 'utf8'));
      assert.equal(owner.pid, process.pid); assert.ok(Date.now() - Date.parse(owner.at) < 5000);
    });
    assert.equal(existsSync(join(dir, '.lock')), false);
  }
});
test('fresh live second-process lock waits until its owner releases', async t => {
  const dir = temp(t);
  const child = fork(new URL('./fixtures/lock-owner.mjs', import.meta.url), [dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => child.kill());
  await once(child, 'message');
  let acquired = false;
  const operation = withStateLock(dir, () => { acquired = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(acquired, false);
  const exited = once(child, 'exit'); child.send('release');
  await operation; await exited;
  assert.equal(acquired, true);
});
test('corrupt log lines are counted and a truncated tail cannot swallow the next decision', t => {
  const dir = temp(t);
  writeFileSync(join(dir, 'decisions.jsonl'), '{bad}\n' + JSON.stringify({ status: 'ok', basis: 'trial', kind: 'docs', route: 'sonnet' }) + '\n{"truncated"');
  assert.equal(readState(dir).unreadableLogLines, 2);
  assert.equal(readState(dir).alternation.docs, 'sonnet');
  logDecision(dir, { status: 'ok', basis: 'trial', kind: 'docs', route: 'astra' });
  assert.equal(readState(dir).alternation.docs, 'astra');
  assert.equal(readState(dir).unreadableLogLines, 2);
});
test('lock release tolerates prior removal', async t => {
  const dir = temp(t);
  await withStateLock(dir, () => rmSync(join(dir, '.lock'), { recursive: true, force: true }));
});
