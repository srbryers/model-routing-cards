import { appendFileSync, mkdirSync, readFileSync, statSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function stateDirectory(env = process.env) {
  return resolve(env.MODEL_ROUTING_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'model-routing'));
}
function readOptional(file, fallback) {
  try { return readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function readState(dir, policy) {
  const alternation = {};
  const poolAlternation = {};
  const { records, unreadableLogLines } = readStateLog(dir, 'decisions.jsonl');
  // ⚠ The log is the alternation record: a crash cannot advance a trial without logging it.
  for (const decision of records) {
    if (decision.status !== 'ok' || decision.basis !== 'trial') continue;
    alternation[decision.kind] = decision.route;
    // ⚠ Logged decisions carry no pool; map the route through policy so a codex pair
    // keeps its own turn even when a tie rotated through Sonnet in between.
    const pool = Object.hasOwn(policy?.routes ?? {}, decision.route) ? policy.routes[decision.route].pool : undefined;
    if (pool) (poolAlternation[decision.kind] ??= {})[pool] = decision.route;
  }
  return { alternation, poolAlternation, unreadableLogLines, limits: JSON.parse(readOptional(join(dir, 'limits.json'), '{}')) };
}
export function readDecisions(dir) {
  return readStateLog(dir, 'decisions.jsonl').records;
}
export function readStateLog(dir, file) {
  const records = [];
  let unreadableLogLines = 0;
  for (const line of readOptional(join(dir, file), '').split('\n').filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid record');
      records.push(record);
    } catch { unreadableLogLines++; }
  }
  return { records, unreadableLogLines };
}
export function appendStateLog(dir, file, record) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, file);
  // ⚠ Preserve a new record even when a killed writer left an unterminated line.
  const previous = readOptional(path, '');
  const separator = previous && !previous.endsWith('\n') ? '\n' : '';
  appendFileSync(path, separator + JSON.stringify(record) + '\n', { mode: 0o600 });
}
export function logDecision(dir, decision, brief) {
  const record = { ...decision, ...(brief === undefined ? {} : { brief: {
    sha256: createHash('sha256').update(brief).digest('hex'), length: brief.length,
  } }) };
  // ⚠ Dispatch arguments contain task text and private identifiers. Keep them only in stdout.
  const logged = { ...record,
    ...(record.approval ? { approval: { route: record.approval.route, costPer1M: record.approval.costPer1M } } : {}),
    ...(record.spawn ? { spawn: { missing: record.spawn.missing } } : {}) };
  appendStateLog(dir, 'decisions.jsonl', logged);
  return record;
}
export function setLimit(dir, route, hours, now) {
  const { limits } = readState(dir);
  const until = new Date(new Date(now).getTime() + hours * 3_600_000).toISOString();
  limits[route] = until;
  const temporary = join(dir, `limits-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(limits) + '\n', { mode: 0o600 });
  renameSync(temporary, join(dir, 'limits.json'));
  return { route, until };
}
function lockOwner(lock) {
  try { return JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); }
  catch { return null; }
}
function reclaimable(lock, owner) {
  let created;
  try { created = statSync(lock).mtimeMs; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const at = Date.parse(owner?.at);
  if (Date.now() - (Number.isFinite(at) ? at : created) > 30_000) return true;
  if (Number.isInteger(owner?.pid) && owner.pid > 0) {
    try { process.kill(owner.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return true; }
  }
  return false;
}
export async function withStateLock(dir, operation) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, '.lock');
  const deadline = Date.now() + 5_000;
  const token = randomUUID();
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }), { mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = lockOwner(lock);
      // ⚠ A contender may have replaced the stale owner while we checked its PID.
      if (reclaimable(lock, owner) && JSON.stringify(lockOwner(lock)) === JSON.stringify(owner)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`State is locked at ${lock}; another process is writing`);
      await delay(20);
    }
  }
  try { return await operation(); }
  finally {
    // ⚠ A reclaimed lease may belong to another writer; the old owner must not release it.
    if (lockOwner(lock)?.token === token) rmSync(lock, { recursive: true, force: true });
  }
}
