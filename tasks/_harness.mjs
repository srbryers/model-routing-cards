/**
 * Shared plumbing for the coding tasks. Not a task itself: it exports no `task`.
 *
 * ⚠⚠ THE FACTS ARE SETTLED BY RUNNING THE CODE, NOT BY READING IT. Did the
 * returned file parse, did the tests pass, how many lines changed — those are
 * code's to answer, exactly and for free. Jev is asked only what has to be read
 * (routing-profile.md: Jev never counts and never does arithmetic).
 *
 * ⚠ MODEL OUTPUT IS UNTRUSTED CODE. It runs in a child process, in a fresh temp
 * directory, under Node's permission model: it may read only that directory,
 * may write nowhere, and may not spawn processes. The permission model does not
 * block the network on Node 22, so this is a guard against accidents, not a
 * sandbox against an adversary.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The candidates named in routing-profile.md, by OpenRouter slug.
 *
 * ⚠⚠ THESE SLUGS ARE UNVERIFIED. They were written without access to the live
 * catalog. `route.mjs run --execute` checks every OpenRouter slug against the
 * catalog before spending anything, so a wrong one fails loudly and for free;
 * fix it here, once. Muse Spark in particular may not be on OpenRouter at all
 * (the research report could not confirm availability outside Meta's US-only
 * API), in which case it needs a provider in scripts/providers.mjs.
 *
 * ⚠ EFFORT IS NOT EXPRESSED. The profile wants Opus 5.5 at extra-high effort;
 * providers.mjs sends no reasoning-effort parameter today, so these runs
 * measure each model at its provider default.
 */
export const MODELS = Object.freeze({
  spark: 'meta/muse-spark-1.3',
  opus: 'anthropic/claude-opus-5.5',
  sonnet: 'anthropic/claude-sonnet-5.5',
  luna: 'openai/gpt-6-luna',
  deepseekPro: 'deepseek/deepseek-v4-pro',
});

/** Every task starts here. A card, not this field, is what changes it. */
export const UNCALIBRATED = Object.freeze({
  status: 'UNCALIBRATED',
  receipts: 0,
  judgeChecked: false,
  note:
    'No runs recorded and the Jev questions have not been checked against ' +
    'known-good and known-bad output. Nothing here recommends a model yet.',
});

/** Code gates first; Jev is asked only when every code gate passed. */
export async function withJudge(facts, ask) {
  if (!Object.values(facts.gates).every(Boolean)) {
    /* ⚠ A failed gate throws the run away, so a judge call here buys nothing. */
    return { gates: facts.gates, metrics: facts.metrics, raw: facts.raw };
  }
  const judged = await ask();
  return {
    gates: { ...facts.gates, ...judged.gates },
    metrics: { ...facts.metrics, ...judged.metrics },
    raw: { ...facts.raw, ...judged.raw },
  };
}

/**
 * The briefing a selected model receives as a subagent.
 *
 * ⚠⚠ FULL TASK CONTEXT, NEVER A BARE PROMPT. The routing profile sends a
 * selected model the whole job: what it is, why, the files it touches, the
 * constraints, and the exact shape of the answer. A bake-off that measured a
 * bare one-liner would be measuring a pipeline nobody runs.
 */
export function brief({ role, goal, background, files = {}, constraints = [], deliverable }) {
  const fileBlocks = Object.entries(files)
    .map(([name, body]) => `--- ${name} ---\n${body.trim()}\n--- end ${name} ---`)
    .join('\n\n');
  return [
    `You are a subagent: ${role}`,
    `## Goal\n${goal.trim()}`,
    `## Background\n${background.trim()}`,
    fileBlocks && `## Files\n${fileBlocks}`,
    constraints.length && `## Constraints\n${constraints.map((c) => `- ${c}`).join('\n')}`,
    `## What to return\n${deliverable.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Every fenced block in the output, in order, with its info string. */
export function fences(output) {
  return [...String(output).matchAll(/```([\w-]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => ({
    lang: m[1].toLowerCase(),
    body: m[2],
  }));
}

/** Run `entry` from a temp dir holding `files`, confined. Never throws. */
export function runConfined(files, entry, { timeoutMs = 10_000 } = {}) {
  /* ⚠ THE REAL PATH, NOT THE TEMP PATH. On macOS tmpdir() sits behind the
     /var → /private/var symlink, Node resolves it on import, and the resolved
     path falls outside an allowance granted to the unresolved one: every case
     then "fails" with an access error that has nothing to do with the model. */
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-task-')));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const out = spawnSync(
      process.execPath,
      ['--permission', `--allow-fs-read=${dir}`, join(dir, entry)],
      { cwd: dir, encoding: 'utf8', timeout: timeoutMs },
    );
    return {
      status: out.status,
      timedOut: out.error?.code === 'ETIMEDOUT' || out.signal === 'SIGTERM',
      stdout: out.stdout ?? '',
      stderr: out.stderr ?? '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Does this ES module source parse? `node --check`, so nothing executes. */
export function parses(source, name = 'module.mjs') {
  const dir = mkdtempSync(join(tmpdir(), 'mrc-check-'));
  try {
    writeFileSync(join(dir, name), source);
    return spawnSync(process.execPath, ['--check', join(dir, name)]).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run named test cases against a module and report which passed.
 *
 * `cases` maps a name to the source of an async function body that receives the
 * module as `m` and throws on failure. The cases never reach the model's
 * prompt: the brief states the behaviour in words, the tests check it here.
 */
export function runCases(moduleName, moduleSource, cases) {
  const runner = `
import assert from 'node:assert/strict';
const m = await import('./${moduleName}');
const cases = {
${Object.entries(cases)
  .map(([name, body]) => `  ${JSON.stringify(name)}: async () => { ${body} },`)
  .join('\n')}
};
const result = { passed: [], failed: [] };
for (const [name, fn] of Object.entries(cases)) {
  try { await fn(); result.passed.push(name); }
  catch (e) { result.failed.push(name + ': ' + String(e?.message ?? e).slice(0, 120)); }
}
console.log('__RESULT__' + JSON.stringify(result));
`;
  const run = runConfined({ [moduleName]: moduleSource, 'runner.mjs': runner }, 'runner.mjs');
  const line = run.stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    /* It never got as far as reporting: it failed to import, or hung. Every
       case counts as failed, which is what happened. */
    return {
      passed: [],
      failed: Object.keys(cases),
      crashed: true,
      error: (run.timedOut ? 'timed out' : run.stderr).slice(0, 200),
    };
  }
  return { ...JSON.parse(line.slice('__RESULT__'.length)), crashed: false };
}

/**
 * How many lines differ between two texts: removed plus added, via LCS.
 * Whitespace at line ends is ignored; files here are small enough for O(n·m).
 */
export function changedLines(before, after) {
  const a = before.replace(/\s+$/, '').split('\n').map((l) => l.trimEnd());
  const b = after.replace(/\s+$/, '').split('\n').map((l) => l.trimEnd());
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return a.length - common + (b.length - common);
}

/**
 * Closeness to a target, 1 at the target and falling to 0 at `tolerance` away.
 * Scores what was asked for rather than a raw count (task-interface.md).
 */
export function closeness(actual, target, tolerance) {
  return Math.max(0, 1 - Math.abs(actual - target) / tolerance);
}
