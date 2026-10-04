/**
 * ⚠⚠ THESE TESTS NEVER RUN `muse`, `claude` OR `codex`. Each one is a model call
 * on a subscription. Every call goes through an injected `spawn`, and the one
 * test that runs the real route.mjs puts fake binaries first on PATH.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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
  claudeEnv,
} from './providers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

const SUBSCRIPTION = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });

/**
 * A fake `spawnSync` that records what it was asked and answers from `reply`.
 * `claude auth status` is answered separately (`opts.auth`) and recorded apart,
 * so `calls[0]` is always the model call.
 */
function fakeSpawn(reply, { auth = { status: 0, stdout: SUBSCRIPTION, stderr: '' } } = {}) {
  const calls = [];
  const authCalls = [];
  const spawn = (cmd, args, opts) => {
    if (cmd === 'claude' && args[0] === 'auth') {
      authCalls.push({ args, opts });
      return auth;
    }
    /* The prompt file only exists during the call, so read it inside the fake. */
    const i = args.indexOf('--prompt-file');
    calls.push({ cmd, args, opts, promptFile: i === -1 ? null : readFileSync(args[i + 1], 'utf8') });
    return typeof reply === 'function' ? reply(cmd, args, opts) : reply;
  };
  spawn.calls = calls;
  spawn.authCalls = authCalls;
  return spawn;
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
  assert.equal(existsSync(opts.cwd), false, 'workspace is removed afterwards');
  assert.equal(opts.timeout, 10 * 60 * 1000);
  assert.equal(opts.killSignal, 'SIGKILL');

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

test('muse failure paths record a category and nothing the CLI printed', async () => {
  const run = (reply) => call(parseModel('muse:muse-spark-1.3'), { prompt: PROMPT, spawn: fakeSpawn(reply) });
  const LEAK = 'user@example.com sk-ant-XXXX';
  const failure = (res, state, error, extra = {}) => {
    assert.deepEqual(res, { state, error, exit_status: null, signal: null, ...extra });
    assert.ok(!JSON.stringify(res).includes('example.com'));
    assert.ok(!JSON.stringify(res).includes('sk-ant'));
  };

  /* A failed run exits 1 and ends with run.terminal.failed; stderr is full of detail. */
  failure(
    await run({ status: 1, stdout: fixture('muse-exec-failed.jsonl'), stderr: `transport error ${LEAK}` }),
    'no_output', 'exit_nonzero', { exit_status: 1 },
  );
  /* Non-zero exit with a completed-looking stream is still a failure. */
  failure(await run({ status: 3, stdout: fixture('muse-exec-ok.jsonl'), stderr: LEAK }), 'no_output', 'exit_nonzero', { exit_status: 3 });
  /* Exit 0 but the run reported failure. */
  failure(await run({ status: 0, stdout: fixture('muse-exec-failed.jsonl'), stderr: LEAK }), 'no_output', 'is_error', { exit_status: 0 });
  /* Unparseable, empty. */
  failure(await run({ status: 0, stdout: `not json ${LEAK}\n{broken`, stderr: LEAK }), 'no_output', 'unparseable', { exit_status: 0 });
  failure(await run({ status: 0, stdout: '', stderr: LEAK }), 'no_output', 'unparseable', { exit_status: 0 });
  /* Killed by a signal. */
  failure(await run({ status: null, signal: 'SIGKILL', stdout: '', stderr: LEAK }), 'no_output', 'exit_nonzero', { signal: 'SIGKILL' });
  /* Timeout, and a binary that will not start. */
  failure(
    await run({ error: Object.assign(new Error(`spawnSync muse ETIMEDOUT ${LEAK}`), { code: 'ETIMEDOUT' }), signal: 'SIGKILL' }),
    'threw', 'timeout', { signal: 'SIGKILL' },
  );
  failure(await run({ error: Object.assign(new Error(`spawnSync muse ENOENT ${LEAK}`), { code: 'ENOENT' }) }), 'threw', 'spawn_failed');
});

test('parseMuseOutput reads the terminal event, not the deltas', () => {
  assert.deepEqual(parseMuseOutput(fixture('muse-exec-ok.jsonl')), { text: 'ok', tokens: { in: null, out: null } });
  assert.deepEqual(parseMuseOutput(fixture('muse-exec-failed.jsonl')), { error: 'is_error' });
  assert.deepEqual(parseMuseOutput(''), { error: 'unparseable' });
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
  assert.equal(existsSync(opts.cwd), false, 'workdir is removed afterwards');
  assert.equal(opts.input, PROMPT);
  assert.ok(!args.some((a) => a.includes('LONG-PROMPT-MARKER')));
  assert.equal(opts.timeout, 10 * 60 * 1000);
  assert.equal(opts.killSignal, 'SIGKILL');
  /* The auth check ran first, with the same sanitised env. */
  assert.equal(spawn.authCalls.length, 1);
  assert.deepEqual(spawn.authCalls[0].args, ['auth', 'status', '--json']);
  assert.deepEqual(spawn.authCalls[0].opts.env, opts.env);

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

/* Every kind of variable that can move `claude -p` onto a metered backend. */
const POLLUTION = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  ANTHROPIC_AUTH_TOKEN: 'tok',
  ANTHROPIC_BASE_URL: 'http://gateway.invalid',
  ANTHROPIC_BEDROCK_BASE_URL: 'http://b.invalid',
  ANTHROPIC_MODEL: 'something',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
  AWS_ACCESS_KEY_ID: 'x',
  AWS_PROFILE: 'x',
  GOOGLE_APPLICATION_CREDENTIALS: '/x',
  GCLOUD_PROJECT: 'x',
  CLOUDSDK_CORE_PROJECT: 'x',
  AZURE_CLIENT_SECRET: 'x',
  OPENROUTER_API_KEY: 'x',
};

test('claude gets an allowlisted env: no metered-backend variable reaches the spawn', async () => {
  const saved = {};
  for (const [k, v] of Object.entries(POLLUTION)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const spawn = fakeSpawn(ok(fixture('claude-print-ok.json')));
    await call(parseModel('claude:claude-sonnet-5-5'), { prompt: PROMPT, spawn });
    for (const env of [spawn.calls[0].opts.env, spawn.authCalls[0].opts.env]) {
      for (const k of Object.keys(POLLUTION)) assert.equal(env[k], undefined, `${k} must not reach claude`);
      assert.equal(env.PATH, process.env.PATH);
      for (const k of Object.keys(env)) {
        assert.ok(!/^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|AZURE_)/.test(k), k);
      }
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('claudeEnv keeps the basics, proxy settings and the subscription token', () => {
  const env = claudeEnv({
    PATH: '/bin', HOME: '/h', USER: 'u', LANG: 'en', TERM: 'xterm', TMPDIR: '/t', SHELL: '/bin/sh',
    HTTPS_PROXY: 'p', http_proxy: 'q', NO_PROXY: 'n', no_proxy: 'm', CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1', SOMETHING_ELSE: 'z',
  });
  assert.deepEqual(Object.keys(env).sort(), [
    'CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'HTTPS_PROXY', 'LANG', 'NO_PROXY', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER',
    'http_proxy', 'no_proxy',
  ]);
});

test('claude is refused, without a model call, unless the login is the subscription', async () => {
  const bad = [
    { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' }), stderr: '' },
    { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }), stderr: '' },
    { status: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' },
    { status: 1, stdout: SUBSCRIPTION, stderr: '' },
    { status: 0, stdout: 'not json', stderr: '' },
    { error: new Error('ENOENT') },
  ];
  for (const auth of bad) {
    const spawn = fakeSpawn(ok(fixture('claude-print-ok.json')), { auth });
    const res = await call(parseModel('claude:claude-sonnet-5-5'), { prompt: PROMPT, spawn });
    assert.deepEqual(res, { state: 'refused', error: 'auth_not_subscription' });
    assert.equal(spawn.calls.length, 0, 'no model call was made');
  }
});

test('claude omits the effort flag when none is given', async () => {
  const spawn = fakeSpawn(ok(fixture('claude-print-ok.json')));
  await call(parseModel('claude:claude-sonnet-5-5'), { prompt: PROMPT, spawn });
  assert.ok(!spawn.calls[0].args.includes('--effort'));
});

test('claude failure paths record a category and nothing the CLI printed', async () => {
  const run = (reply) => call(parseModel('claude:claude-sonnet-5-5'), { prompt: PROMPT, spawn: fakeSpawn(reply) });
  const LEAK = 'user@example.com sk-ant-XXXX';
  const failure = (res, state, error, extra = {}) => {
    assert.deepEqual(res, { state, error, exit_status: null, signal: null, ...extra });
    const text = JSON.stringify(res);
    assert.ok(!text.includes('example.com') && !text.includes('sk-ant') && !text.includes('proxy'));
  };

  /* A failed call prints a result object whose `result` is the error message.
     It must not be read as an answer, and must not reach the receipt. */
  const errorJson = fixture('claude-print-error.json').replace('"is_error": true', `"is_error": true, "leak": "${LEAK}"`);
  failure(await run({ status: 1, stdout: errorJson, stderr: LEAK }), 'no_output', 'exit_nonzero', { exit_status: 1 });
  /* Even with exit 0, is_error true is a failure. */
  failure(await run({ status: 0, stdout: errorJson, stderr: LEAK }), 'no_output', 'is_error', { exit_status: 0 });
  failure(await run({ status: 2, stdout: fixture('claude-print-ok.json'), stderr: LEAK }), 'no_output', 'exit_nonzero', { exit_status: 2 });
  failure(await run({ status: 0, stdout: `not json ${LEAK}`, stderr: LEAK }), 'no_output', 'unparseable', { exit_status: 0 });
  failure(await run({ status: 0, stdout: JSON.stringify({ is_error: false, result: '' }), stderr: LEAK }), 'no_output', 'unparseable', { exit_status: 0 });
  failure(await run({ status: 0, stdout: '', stderr: LEAK }), 'no_output', 'unparseable', { exit_status: 0 });
  failure(await run({ status: null, signal: 'SIGKILL', stdout: '', stderr: LEAK }), 'no_output', 'exit_nonzero', { signal: 'SIGKILL' });
  failure(
    await run({ error: Object.assign(new Error(`spawnSync claude ETIMEDOUT ${LEAK}`), { code: 'ETIMEDOUT' }), signal: 'SIGKILL' }),
    'threw', 'timeout', { signal: 'SIGKILL' },
  );
  failure(await run({ error: Object.assign(new Error(`spawnSync claude ENOENT ${LEAK}`), { code: 'ENOENT' }) }), 'threw', 'spawn_failed');
});

test('parseClaudeOutput reports a truncated answer as length and missing usage as null', () => {
  const cut = parseClaudeOutput(JSON.stringify({ is_error: false, result: 'partial', stop_reason: 'max_tokens' }));
  assert.equal(cut.finish_reason, 'length');
  assert.deepEqual(cut.tokens, { in: null, out: null });
  assert.deepEqual(parseClaudeOutput('nope'), { error: 'unparseable' });
  assert.deepEqual(parseClaudeOutput(fixture('claude-print-error.json')), { error: 'is_error' });
});

/* ── codex keeps working, with a timeout and no leaked stderr ───────────── */

const CODEX_OK =
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }) +
  '\n' +
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 2 } });

test('codex goes through the injected spawn, with a hard timeout', async () => {
  const spawn = fakeSpawn(ok(CODEX_OK));
  const res = await call(parseModel('codex:gpt-5.5'), { prompt: PROMPT, spawn });
  assert.equal(spawn.calls[0].cmd, 'codex');
  assert.equal(spawn.calls[0].opts.timeout, 10 * 60 * 1000);
  assert.equal(spawn.calls[0].opts.killSignal, 'SIGKILL');
  assert.equal(res.text, 'done');
  assert.equal(res.cost_usd, null);
  assert.deepEqual(res.tokens, { in: 7, out: 2 });
});

test('codex failure records a category, not stderr', async () => {
  const LEAK = 'user@example.com sk-ant-XXXX';
  const run = (reply) => call(parseModel('codex:gpt-5.5'), { prompt: PROMPT, spawn: fakeSpawn(reply) });
  assert.deepEqual(await run({ status: 1, stdout: '', stderr: LEAK }), {
    state: 'no_output', error: 'exit_nonzero', exit_status: 1, signal: null,
  });
  assert.deepEqual(await run({ status: 0, stdout: 'garbage', stderr: LEAK }), {
    state: 'no_output', error: 'unparseable', exit_status: 0, signal: null,
  });
  const res = await run({ error: Object.assign(new Error(`ETIMEDOUT ${LEAK}`), { code: 'ETIMEDOUT' }), signal: 'SIGKILL' });
  assert.deepEqual(res, { state: 'threw', error: 'timeout', exit_status: null, signal: 'SIGKILL' });
});

/* ── a fresh, removed directory for every call ──────────────────────────── */

test('every CLI call gets its own empty workdir, and both directories are removed', async () => {
  const cases = [
    ['muse:muse-spark-1.3', ok(fixture('muse-exec-ok.jsonl'))],
    ['claude:claude-sonnet-5-5', ok(fixture('claude-print-ok.json'))],
    ['codex:gpt-5.5', ok(CODEX_OK)],
  ];
  for (const [label, reply] of cases) {
    const seen = [];
    const spawn = fakeSpawn((cmd, args, opts) => {
      /* At call time the workdir exists and is empty. */
      assert.deepEqual(readdirSync(opts.cwd), [], `${label} workdir starts empty`);
      writeFileSync(join(opts.cwd, 'left-behind.txt'), 'from an earlier run');
      seen.push(opts.cwd);
      return reply;
    });
    const spec = parseModel(label);
    await call(spec, { prompt: PROMPT, schema: label.startsWith('codex') ? { type: 'object' } : null, spawn });
    await call(spec, { prompt: PROMPT, schema: label.startsWith('codex') ? { type: 'object' } : null, spawn });
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1], `${label}: two calls get different directories`);
    for (const dir of seen) assert.equal(existsSync(dir), false, `${label}: ${dir} is removed`);
  }
});

test('the muse prompt and codex schema live outside the workspace and are removed', async () => {
  const museSpawn = fakeSpawn(ok(fixture('muse-exec-ok.jsonl')));
  await call(parseModel('muse:muse-spark-1.3'), { prompt: PROMPT, spawn: museSpawn });
  const m = museSpawn.calls[0];
  const promptFile = m.args[m.args.indexOf('--prompt-file') + 1];
  assert.notEqual(dirname(promptFile), m.opts.cwd);
  assert.equal(existsSync(dirname(promptFile)), false);

  const codexSpawn = fakeSpawn(ok(CODEX_OK));
  await call(parseModel('codex:gpt-5.5'), { prompt: PROMPT, schema: { type: 'object' }, spawn: codexSpawn });
  const c = codexSpawn.calls[0];
  const schemaFile = c.args[c.args.indexOf('--output-schema') + 1];
  assert.notEqual(dirname(schemaFile), c.opts.cwd);
  assert.equal(existsSync(schemaFile), false);
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
