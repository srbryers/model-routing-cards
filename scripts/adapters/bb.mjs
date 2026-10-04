/** All worker-host commands and argument conventions live in this adapter. */
import { execFileSync } from 'node:child_process';

export function normalizeQuota(raw) {
  const result = {};
  for (const [provider, pool] of [['claude-code', 'claude'], ['codex', 'codex']]) {
    const entry = raw?.[provider];
    if (entry?.status !== 'ok' || !Array.isArray(entry.windows)) continue;
    const windows = entry.windows.filter(w => ['weekly', 'five-hour'].includes(w?.kind)
      && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100
      && typeof w.resetsAt === 'string' && Number.isFinite(Date.parse(w.resetsAt)))
      .map(({ kind, usedPercent, resetsAt }) => ({ kind, usedPercent, resetsAt }));
    if (windows.length) result[pool] = { windows };
  }
  return Object.keys(result).length ? result : null;
}

export function readQuota({ execFile = execFileSync } = {}) {
  try {
    return normalizeQuota(JSON.parse(execFile('bb', ['settings', 'usage', '--json'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    })));
  } catch {
    // ⚠ Usage output and command errors may contain account details; never pass them through.
    return null;
  }
}

export function buildSpawn(decision, input) {
  if (decision.status !== 'ok') return undefined;
  const argv = ['bb', 'thread', 'spawn'];
  const missing = [];
  const add = (name, value, key = name) => {
    if (value === undefined || value === null || value === '') missing.push(key);
    else argv.push(`--${name}`, value);
  };
  add('project', input.project);
  argv.push('--parent-self');
  add('section', input.section);
  argv.push('--new-environment', 'worktree');
  add('provider', decision.provider);
  add('model', decision.model);
  add('reasoning-level', decision.reasoning);
  add('machine', decision.machine);
  add('title', input.title);
  add('prompt-file', input.promptFile);
  return { argv, missing };
}
