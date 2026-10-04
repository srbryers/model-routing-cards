/** All worker-host commands and argument conventions live in this adapter. */
import { execFileSync } from 'node:child_process';

export function normalizeQuota(raw) {
  const result = {};
  for (const [provider, pool] of [['claude-code', 'claude'], ['codex', 'codex']]) {
    const entry = raw?.[provider];
    if (entry?.status !== 'ok' || !Array.isArray(entry.windows)) continue;
    const byKind = new Map();
    for (const w of entry.windows) {
      // ⚠ Model sub-limits are not the shared pool; duplicates must fail closed.
      if (!w || Object.hasOwn(w, 'model') || !['weekly', 'five-hour'].includes(w.kind)
        || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100
        || typeof w.resetsAt !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(w.resetsAt)
        || !Number.isFinite(Date.parse(w.resetsAt))) continue;
      if (!byKind.has(w.kind) || w.usedPercent > byKind.get(w.kind).usedPercent) {
        const { kind, usedPercent, resetsAt } = w;
        byKind.set(kind, { kind, usedPercent, resetsAt });
      }
    }
    const windows = [...byKind.values()];
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
  if (!['ok', 'needs_approval'].includes(decision.status)) return undefined;
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
  // ⚠ Null explicitly means this route has no reasoning setting.
  if (decision.reasoning !== null) add('reasoning-level', decision.reasoning);
  add('machine', decision.machine);
  add('title', input.title);
  add('prompt-file', input.promptFile);
  return { argv, missing };
}
