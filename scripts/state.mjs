import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
export function readState(dir) {
  const alternation = {};
  // ⚠ The log is the alternation record: a crash cannot advance a trial without logging it.
  for (const line of readOptional(join(dir, 'decisions.jsonl'), '').split('\n').filter(Boolean)) {
    const decision = JSON.parse(line);
    if (decision.status === 'ok' && decision.basis === 'trial') alternation[decision.kind] = decision.route;
  }
  return { alternation, limits: JSON.parse(readOptional(join(dir, 'limits.json'), '{}')) };
}
export function logDecision(dir, decision, brief) {
  const record = { ...decision, ...(brief === undefined ? {} : { brief: {
    sha256: createHash('sha256').update(brief).digest('hex'), length: brief.length,
  } }) };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, 'decisions.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
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
export async function withStateLock(dir, operation) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, '.lock');
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`State is locked at ${lock}; check for an active pick or limit process before removing the lock`);
      await delay(20);
    }
  }
  try { return await operation(); }
  finally { rmSync(lock, { recursive: true }); }
}
