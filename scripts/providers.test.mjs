/**
 * ⚠⚠ THESE TESTS NEVER RUN `muse`, `claude` OR `codex`. Each one is a model call
 * on a subscription. Every call goes through an injected `spawn`, and the one
 * test that runs the real route.mjs puts fake binaries first on PATH.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  call,
  parseModel,
  needsKey,
  keyNames,
  keyNameFor,
  isContributorModel,
  parseMuseOutput,
  parseClaudeOutput,
} from './providers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

/** A fake `spawnSync` that records what it was asked and answers from `reply`. */
function fakeSpawn(reply) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts, promptFile: readPromptFile(args) });
    return typeof reply === 'function' ? reply(cmd, args, opts) : reply;
  };
  spawn.calls = calls;
  return spawn;
}

/* The prompt file only exists during the call, so read it inside the fake. */
function readPromptFile(args) {
  const i = args.indexOf('--prompt-file');
  return i === -1 ? null : readFileSync(args[i + 1], 'utf8');
}

const noSpawn = fakeSpawn(() => {
  throw new Error('spawn must not be called');
});

const PROMPT = 'LONG-PROMPT-MARKER ' + 'x'.repeat(5000);
const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

/* ── parseModel ─────────────────────────────────────────────────────────── */

test('parseModel reads the muse: and claude: prefixes', () => {
  assert.deepEqual(parseModel('muse:muse-spark-1.3'), {
    provider: 'muse', model: 'muse-spark-1.3', reasoning: null, label: 'muse:muse-spark-1.3',
  });
  assert.deepEqual(parseModel('claude:claude-sonnet-5-5'), {
    provider: 'claude', model: 'claude-sonnet-5-5', reasoning: null, label: 'claude:claude-sonnet-5-5',
  });
});

test('parseModel carries reasoning from an object entry', () => {
  const spec = parseModel({ provider: 'muse', model: 'muse-spark-1.3', reasoning: 'low' });
  assert.equal(spec.reasoning, 'low');
  assert.equal(spec.label, 'muse:muse-spark-1.3');
});

test('existing prefixes and bare slugs still resolve', () => {
  assert.equal(parseModel('codex:gpt-5.5').provider, 'codex');
  assert.equal(parseModel('chatgpt:gpt-5.5').provider, 'chatgpt');
  assert.equal(parseModel('subconscious:x').provider, 'subconscious');
  assert.equal(parseModel('google/gemini-3.8-flash').provider, 'openrouter');
});

/* ── keys ───────────────────────────────────────────────────────────────── */

test('muse and claude need no API key', () => {
  const specs = ['muse:muse-spark-1.3', 'claude:claude-sonnet-5-5'].map(parseModel);
  assert.equal(keyNameFor('muse'), null);
  assert.equal(keyNameFor('claude'), null);
  assert.deepEqual(keyNames(specs), []);
  assert.equal(needsKey(specs), false);
  assert.equal(needsKey([...specs, parseModel('a/b')]), true);
});

/* ── muse: refusal ──────────────────────────────────────────────────────── */

test('a -contributor muse model is refused without spawning', async () => {
  for (const model of ['muse-spark-1.3-contributor', 'muse-spark-1.3-Contributor', 'x-contributor-y']) {
    assert.equal(isContributorModel(model), true);
    const res = await call(parseModel(`muse:${model}`), { prompt: PROMPT, spawn: noSpawn });
    assert.equal(res.state, 'refused');
    assert.match(res.error, /contributor/);
    /* …and by object entry, which skips the prefix path. */
    const viaObject = await call(parseModel({ provider: 'muse', model }), { prompt: PROMPT, spawn: noSpawn });
    assert.equal(viaObject.state, 'refused');
  }
  assert.equal(noSpawn.calls.length, 0);
  assert.equal(isContributorModel('muse-spark-1.3'), false);
});

test('a flag-like or empty model id, or an unknown effort, is refused without spawning', async () => {
  for (const spec of [
    parseModel('muse:--yolo'),
    parseModel('muse:'),
    parseModel('claude:--dangerously-skip-permissions'),
    parseModel({ provider: 'muse', model: 'muse-spark-1.3', reasoning: 'ultra-max' }),
    parseModel({ provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'none' }),
  ]) {
    const res = await call(spec, { prompt: PROMPT, spawn: noSpawn });
    assert.equal(res.state, 'refused', spec.label);
  }
  assert.equal(noSpawn.calls.length, 0);
});

/* ── muse: argv and envelope ────────────────────────────────────────────── */

test('muse builds a confined argv with the prompt in a file', async () => {
  const spawn = fakeSpawn(ok(fixture('muse-exec-ok.jsonl')));
  const spec = parseModel({ provider: 'muse', model: 'muse-spark-1.3', reasoning: 'low' });
  const res = await call(spec, { prompt: PROMPT, spawn });

  const [{ cmd, args, opts, promptFile }] = spawn.calls;
  assert.equal(cmd, 'muse');
  const flag = (n) => args[args.indexOf(n) + 1];
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--json'));
  assert.equal(flag('--model'), 'muse-spark-1.3');
  assert.equal(flag('--reasoning-effort'), 'low');
  assert.equal(flag('--worktree'), 'off');
  assert.equal(flag('--approval-mode'), 'never');
  for (const f of ['--disable-shell', '--disable-write', '--disable-web-tools', '--no-session-log']) {
    assert.ok(args.includes(f), f);
  }
  for (const f of ['--yolo', '--disable-approval', '--disable-sandbox', '--trust-workspace', '--enable-shell-tool']) {
    assert.ok(!args.includes(f), `${f} must never be passed`);
  }

  /* Empty temp workdir, used as both cwd and workspace root. */
  assert.ok(opts.cwd.startsWith(tmpdir()));
  assert.equal(flag('--workspace'), opts.cwd);
  /* The prompt reaches the CLI by file, never by argv or stdin. */
  assert.equal(promptFile, PROMPT);
  assert.ok(!args.some((a) => a.includes('LONG-PROMPT-MARKER')));
  assert.ok(!flag('--prompt-file').startsWith(opts.cwd), 'prompt file is outside the workspace');
  assert.equal(existsSync(flag('--prompt-file')), false, 'prompt file is removed afterwards');
  assert.equal(opts.timeout, 10 * 60 * 1000);

  assert.deepEqual(res, {
    state: 'completed',
    text: 'ok',
    finish_reason: 'stop',
    cost_usd: null,
    cost_source: 'subscription',
    tokens: { in: null, out: null },
  });
});

test('muse omits the effort flag when none is given', async () => {
  const spawn = fakeSpawn(ok(fixture('muse-exec-ok.jsonl')));
  await call(parseModel('muse:muse-spark-1.3'), { prompt: PROMPT, spawn });
  assert.ok(!spawn.calls[0].args.includes('--reasoning-effort'));
});

test('muse failure paths give an error state, not a crash', async () => {
  const run = (reply) => call(parseModel('muse:muse-spark-1.3'), { prompt: PROMPT, spawn: fakeSpawn(reply) });

  /* A failed run exits 1 and ends with run.terminal.failed. */
  const failed = await run({
    status: 1,
    stdout: fixture('muse-exec-failed.jsonl'),
    stderr: 'muse: workspace root: /x\nrun ended with Failed: transport error\n' + 'e'.repeat(500),
  });
  assert.equal(failed.state, 'no_output');
  assert.ok(failed.error.length <= 200, 'stderr is cut to 200 characters, as viaCodex does');
  assert.equal(failed.text, undefined);

  /* Non-zero exit with a completed-looking stream is still a failure. */
  assert.equal((await run({ status: 1, stdout: fixture('muse-exec-ok.jsonl'), stderr: '' })).state, 'no_output');
  /* Unparseable, empty. */
  assert.equal((await run(ok('not json\n{broken'))).state, 'no_output');
  assert.equal((await run(ok(''))).state, 'no_output');
  /* Timeout or missing binary. */
  const timedOut = await run({ error: Object.assign(new Error('spawnSync muse ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  assert.equal(timedOut.state, 'threw');
  assert.match(timedOut.error, /ETIMEDOUT/);
  assert.equal((await run({ error: new Error('spawnSync muse ENOENT') })).state, 'threw');
});

test('parseMuseOutput reads the terminal event, not the deltas', () => {
  assert.deepEqual(parseMuseOutput(fixture('muse-exec-ok.jsonl')), { text: 'ok', tokens: { in: null, out: null } });
  assert.equal(parseMuseOutput(fixture('muse-exec-failed.jsonl')), null);
});

/* ── claude: argv and envelope ──────────────────────────────────────────── */

test('claude builds a tool-free argv with the prompt on stdin', async () => {
  const spawn = fakeSpawn(ok(fixture('claude-print-ok.json')));
  const spec = parseModel({ provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'high' });
  const res = await call(spec, { prompt: PROMPT, spawn });

  const [{ cmd, args, opts }] = spawn.calls;
  assert.equal(cmd, 'claude');
  const flag = (n) => args[args.indexOf(n) + 1];
  assert.ok(args.includes('--print'));
  assert.equal(flag('--output-format'), 'json');
  assert.equal(flag('--model'), 'claude-sonnet-5-5');
  assert.equal(flag('--effort'), 'high');
  /* `--tools ""` is the empty list: no built-in tool at all. */
  assert.equal(flag('--tools'), '');
  assert.equal(flag('--setting-sources'), '');
  for (const f of ['--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config']) {
    assert.ok(args.includes(f), f);
  }
  for (const f of ['--dangerously-skip-permissions', '--allowedTools', '--add-dir', '--mcp-config', '--bare']) {
    assert.ok(!args.includes(f), `${f} must never be passed`);
  }
  assert.ok(opts.cwd.startsWith(tmpdir()));
  assert.equal(opts.input, PROMPT);
  assert.ok(!args.some((a) => a.includes('LONG-PROMPT-MARKER')));
  assert.equal(opts.timeout, 10 * 60 * 1000);

  assert.deepEqual(res, {
    state: 'completed',
    text: 'ok',
    finish_reason: 'stop',
    cost_usd: null,
    cost_source: 'subscription',
    /* 10 uncached + 6544 cache-write + 0 cache-read; 40 out. */
    tokens: { in: 6554, out: 40 },
  });
});

test('claude never sees an API key, so it cannot bill the API', async () => {
  const saved = { a: process.env.ANTHROPIC_API_KEY, b: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  process.env.ANTHROPIC_AUTH_TOKEN = 'tok-test-not-real';
  try {
    const spawn = fakeSpawn(ok(fixture('claude-print-ok.json')));
    await call(parseModel('claude:claude-sonnet-5-5'), { prompt: PROMPT, spawn });
    const env = spawn.calls[0].opts.env;
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.PATH, process.env.PATH, 'the rest of the environment is kept');
  } finally {
    for (const [k, v] of [['ANTHROPIC_API_KEY', saved.a], ['ANTHROPIC_AUTH_TOKEN', saved.b]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('claude omits the effort flag when none is given', async () => {
  const spawn = fakeSpawn(ok(fixture('claude-print-ok.json')));
  await call(parseModel('claude:claude-sonnet-5-5'), { prompt: PROMPT, spawn });
  assert.ok(!spawn.calls[0].args.includes('--effort'));
});

test('claude failure paths give an error state, not a crash', async () => {
  const run = (reply) => call(parseModel('claude:claude-sonnet-5-5'), { prompt: PROMPT, spawn: fakeSpawn(reply) });

  /* A failed call prints a result object whose `result` is the error message.
     It must not be read as an answer, and must not reach the receipt. */
  const apiError = await run({ status: 1, stdout: fixture('claude-print-error.json'), stderr: '' });
  assert.equal(apiError.state, 'no_output');
  assert.equal(apiError.text, undefined);
  assert.ok(!JSON.stringify(apiError).includes('proxy'));

  /* Even with exit 0, is_error true is a failure. */
  assert.equal((await run(ok(fixture('claude-print-error.json')))).state, 'no_output');
  /* Non-zero exit, unparseable, empty. */
  assert.equal((await run({ status: 2, stdout: fixture('claude-print-ok.json'), stderr: 'boom' })).state, 'no_output');
  assert.equal((await run(ok('not json'))).state, 'no_output');
  assert.equal((await run(ok(JSON.stringify({ is_error: false, result: '' })))).state, 'no_output');
  assert.equal((await run(ok(''))).state, 'no_output');
  /* Timeout. */
  const timedOut = await run({ error: Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  assert.equal(timedOut.state, 'threw');
});

test('parseClaudeOutput reports a truncated answer as length and missing usage as null', () => {
  const cut = parseClaudeOutput(JSON.stringify({ is_error: false, result: 'partial', stop_reason: 'max_tokens' }));
  assert.equal(cut.finish_reason, 'length');
  assert.deepEqual(cut.tokens, { in: null, out: null });
});

/* ── codex keeps working, and now has a timeout ─────────────────────────── */

test('codex goes through the injected spawn and has a timeout', async () => {
  const spawn = fakeSpawn(
    ok(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }) +
        '\n' +
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 2 } }),
    ),
  );
  const res = await call(parseModel('codex:gpt-5.5'), { prompt: PROMPT, spawn });
  assert.equal(spawn.calls[0].cmd, 'codex');
  assert.equal(spawn.calls[0].opts.timeout, 10 * 60 * 1000);
  assert.equal(res.text, 'done');
  assert.equal(res.cost_usd, null);
  assert.deepEqual(res.tokens, { in: 7, out: 2 });
});

/* ── route.mjs: a dry run spawns nothing ────────────────────────────────── */

test('route.mjs without --execute never starts muse or claude', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routing-dryrun-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const marker = join(dir, 'spawned');
  /* Fake binaries that leave a marker if they are ever started. */
  for (const name of ['muse', 'claude', 'codex']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> "${marker}"\nexit 1\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const taskFile = join(dir, 'task.mjs');
  writeFileSync(
    taskFile,
    `export const task = {
       id: 'dry', models: ['muse:muse-spark-1.3', 'claude:claude-sonnet-5-5', 'codex:gpt-5.5'],
       input: {}, prompt: () => 'hi', score: () => ({ gates: {}, metrics: {} }), weights: {},
     };`,
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.OPENROUTER_API_KEY;
  const out = spawnSync(process.execPath, [join(here, 'route.mjs'), 'run', taskFile], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /nothing was sent/);
  assert.equal(existsSync(marker), false, 'no CLI was started');
});

test('route.mjs refuses a muse contributor model even on a dry run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routing-contrib-'));
  const taskFile = join(dir, 'task.mjs');
  writeFileSync(
    taskFile,
    `export const task = {
       id: 'contrib', models: ['muse:muse-spark-1.3-contributor'],
       input: {}, prompt: () => 'hi', score: () => ({ gates: {}, metrics: {} }), weights: {},
     };`,
  );
  const out = spawnSync(process.execPath, [join(here, 'route.mjs'), 'run', taskFile], { encoding: 'utf8' });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /contributor/);
});
