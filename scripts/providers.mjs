/**
 * Where a model call actually goes.
 *
 * ⚠⚠ A ROUTING TOOL THAT KNOWS ONE GATEWAY IS NOT A ROUTING TOOL. The first
 * version spoke only OpenRouter, which made "use my OpenAI subscription instead"
 * unanswerable — and a subscription is not a cheaper OpenRouter, it is a
 * different shape: the auth belongs to a CLI, and there is no per-token cost to
 * report at all.
 *
 * Six providers today. Each returns the same envelope so the scorer and the
 * trust gate never learn which one ran.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

/** `{provider, model}` from either a bare slug or an explicit object. */
export function parseModel(entry) {
  if (typeof entry === 'string') {
    for (const [prefix, provider] of [
      ['codex:', 'codex'],
      ['muse:', 'muse'],
      ['claude:', 'claude'],
      ['chatgpt:', 'chatgpt'],
      ['subconscious:', 'subconscious'],
    ]) {
      if (entry.startsWith(prefix)) {
        return { provider, model: entry.slice(prefix.length), reasoning: null, label: entry };
      }
    }
    return { provider: 'openrouter', model: entry, reasoning: null, label: entry };
  }
  return {
    provider: entry.provider ?? 'openrouter',
    model: entry.model,
    /* Only the CLI providers read this: `muse` and `claude` take an effort level. */
    reasoning: entry.reasoning ?? null,
    label: entry.label ?? `${entry.provider ?? 'openrouter'}:${entry.model}`,
  };
}

/* ── OpenRouter ─────────────────────────────────────────────────────────── */

async function viaOpenRouter({ model, prompt, schema, key }) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      /* ⚠ ASCII ONLY — an HTTP header is a ByteString; an em-dash throws
         "character > 255" after the tokens are already paid for. */
      'X-Title': 'model-routing bakeoff',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      ...(schema ? { response_format: { type: 'json_schema', json_schema: schema } } : {}),
      usage: { include: true },
    }),
  });
  if (!res.ok) {
    /* ⚠ Status only — some providers echo the request, key included. */
    return { state: 'http_error', status: res.status };
  }
  const body = await res.json();
  return {
    state: 'completed',
    text: body.choices?.[0]?.message?.content ?? '',
    finish_reason: body.choices?.[0]?.finish_reason ?? null,
    cost_usd: typeof body.usage?.cost === 'number' ? body.usage.cost : null,
    cost_source: 'reported',
    tokens: { in: body.usage?.prompt_tokens ?? null, out: body.usage?.completion_tokens ?? null },
  };
}

/* ── Subconscious ───────────────────────────────────────────────────────── */

/**
 * OpenAI-shaped, so this is the OpenRouter call with three differences that all
 * cost something to learn.
 *
 * ⚠⚠ THE MODEL ID CARRIES ITS PROVIDER PREFIX. `deepseek-v4-flash-marathon`
 * answers `403 model_not_allowed`; `subconscious/deepseek-v4-flash-marathon`
 * answers 200. Ask `GET /v1/models` what it calls a model rather than typing
 * what the docs call it — one project's sprint lost an end-to-end run to this.
 *
 * ⚠ IT REPORTS NO COST. There is no `usage.cost`, so the envelope carries
 * tokens and `cost_source: 'computed'`, and the caller prices them from the
 * task's own table. A `null` cost would make "cost per accepted result" — the
 * number this whole tool exists to produce — silently unavailable.
 *
 * ⚠ AND ITS ENTITLEMENT IS NARROWER THAN ITS CATALOG. `/v1/models` lists models
 * a given key may not call, so a 403 here means "not on this key", not "not a
 * model". The status is reported rather than interpreted.
 */
async function viaSubconscious({ model, prompt, schema, key }) {
  const res = await fetch('https://api.subconscious.dev/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      ...(schema ? { response_format: { type: 'json_schema', json_schema: schema } } : {}),
    }),
  });
  if (!res.ok) {
    /* ⚠ Status only — some providers echo the request, key included. */
    return { state: 'http_error', status: res.status };
  }
  const body = await res.json();
  const u = body.usage ?? {};
  return {
    state: 'completed',
    text: body.choices?.[0]?.message?.content ?? '',
    finish_reason: body.choices?.[0]?.finish_reason ?? null,
    cost_usd: null,
    cost_source: 'computed',
    tokens: { in: u.prompt_tokens ?? null, out: u.completion_tokens ?? null },
  };
}

/* ── Codex CLI (a ChatGPT subscription) ─────────────────────────────────── */

/**
 * ⚠⚠ A FRESH EMPTY DIRECTORY PER CALL, REMOVED AFTERWARDS. The first version
 * reused one fixed directory because the CLI puts the working directory into the
 * model's context, and a new path changes the prompt prefix: measured in a
 * private repo as cached input falling from 19,840 to 2,432 tokens. That saving
 * is given up on purpose. A reused directory is only empty the first time —
 * anything an earlier run left in it is readable by the next one, which is no
 * confinement at all. Codex pays the lost cache; correctness comes first.
 *
 * `scratch` is a second directory, outside the workspace, for files the CLI must
 * read but the model must not (the Muse prompt, the Codex schema).
 */
export function callDirs({ mkdtemp = mkdtempSync, rm = rmSync } = {}) {
  const workdir = mkdtemp(join(tmpdir(), 'model-routing-'));
  let scratch;
  try {
    scratch = mkdtemp(join(tmpdir(), 'model-routing-scratch-'));
  } catch (err) {
    /* ⚠ The first directory exists already; leaving it would leak one per failure. */
    try {
      rm(workdir, { recursive: true, force: true });
    } catch {
      /* nothing more can be done, and the original error matters more */
    }
    throw err;
  }
  return {
    workdir,
    scratch,
    remove() {
      /* ⚠ EACH DIRECTORY IN ITS OWN try. The scratch directory holds the prompt,
         so a failure removing the workdir must not skip it. */
      for (const dir of [scratch, workdir]) {
        try {
          rm(dir, { recursive: true, force: true });
        } catch {
          /* best effort: a cleanup failure must not turn an answer into a crash */
        }
      }
    },
  };
}

/**
 * ⚠ A hard deadline. `spawnSync` has no timeout unless asked, and an agent CLI
 * can sit on a stalled stream for as long as it likes. Ten minutes is far longer
 * than any single answer takes and short enough that one stuck call costs a run,
 * not the evening. SIGKILL, because the default SIGTERM can be caught or ignored,
 * and then the "timeout" is only a request.
 */
const CLI_TIMEOUT_MS = 10 * 60 * 1000;
const CLI_KILL_SIGNAL = 'SIGKILL';

/**
 * ⚠⚠ A FAILED CLI CALL RECORDS A CATEGORY, NEVER ITS OUTPUT. The first version
 * copied `stderr.slice(0, 200)` into the receipt, and stderr can carry the
 * account, a path, or an echo of the request. Receipts are kept and shared, so
 * `error` is one of a fixed set and the only detail is the exit status and signal.
 * Nothing the model or the CLI printed reaches a receipt.
 *
 *   spawn_failed   the binary would not start
 *   timeout        killed at the deadline
 *   exit_nonzero   exited non-zero, or was killed by a signal
 *   is_error       the CLI ran and reported its own failure
 *   unparseable    exit 0, but no answer could be read from stdout
 */
function cliFailure(out, category) {
  return {
    state: category === 'spawn_failed' || category === 'timeout' ? 'threw' : 'no_output',
    error: category,
    exit_status: out.status ?? null,
    signal: out.signal ?? null,
  };
}

/** Why a spawn that returned `error` failed, as a category. */
function spawnErrorCategory(out) {
  return out.error?.code === 'ETIMEDOUT' ? 'timeout' : 'spawn_failed';
}

/** The category for a call that exited without a usable answer. */
function exitCategory(out, parsedError) {
  return out.status !== 0 || out.signal ? 'exit_nonzero' : (parsedError ?? 'unparseable');
}

function viaCodex({ model, prompt, schema, spawn = spawnSync }) {
  const dirs = callDirs();
  try {
    return runCodex({ model, prompt, schema, spawn, dirs });
  } finally {
    dirs.remove();
  }
}

function runCodex({ model, prompt, schema, spawn, dirs }) {
  const workdir = dirs.workdir;
  let schemaPath = null;
  if (schema) {
    schemaPath = join(dirs.scratch, 'schema.json');
    writeFileSync(schemaPath, JSON.stringify(schema.schema ?? schema));
  }

  /**
   * ⚠⚠ `codex exec` IS AN AGENT, NOT A COMPLETION, AND THAT COST REAL MONEY.
   * Run inside a repo it goes exploring: one call in a private repo returned a
   * tree describing that repo's git state instead of answering the brief, at
   * roughly 24× a normal call's tokens, because it had been reading the working
   * tree. A budget ceiling cannot catch that — it is checked BEFORE the call.
   *
   * So the call is confined rather than trusted. An empty `--cd` gives it
   * nothing to read; `--sandbox read-only` stops model-generated commands
   * writing. Both matter, and the prompt already carries everything it needs.
   */
  const out = spawn(
    'codex',
    [
      'exec',
      '-m',
      model,
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--cd',
      workdir,
      '--json',
      ...(schemaPath ? ['--output-schema', schemaPath] : []),
      '-',
    ],
    {
      input: prompt,
      encoding: 'utf8',
      cwd: workdir,
      maxBuffer: 64 * 1024 * 1024,
      timeout: CLI_TIMEOUT_MS,
      killSignal: CLI_KILL_SIGNAL,
    },
  );

  if (out.error) return cliFailure(out, spawnErrorCategory(out));

  /**
   * ⚠⚠ A FAILED RUN IS NOT A COMPLETED ONE, WHATEVER TEXT IT PRINTED. A run that
   * exits 1 can still have emitted an `agent_message` first, and the first version
   * accepted that text and scored it. The exit status and signal are checked
   * before any text is read, and so is an explicit `turn.failed` event.
   */
  if (out.status !== 0 || out.signal) return cliFailure(out, 'exit_nonzero');

  /**
   * ⚠ THE EVENT STREAM IS ON STDOUT AND THE NOISE IS ON STDERR. The CLI dumps a
   * models catalogue to stderr at startup which contains the word `usage` and
   * whole JSON objects; a probe that searched both streams matched the dump and
   * read a wrong number confidently. Parse stdout, line by line, by event type.
   */
  const events = jsonLines(out.stdout);

  const last = events.findLast((e) => ['turn.completed', 'turn.failed', 'error'].includes(e.type));
  if (events.some((e) => e.type === 'turn.failed') || last?.type === 'error') {
    return cliFailure(out, 'is_error');
  }

  const usage = events.findLast((e) => e.type === 'turn.completed')?.usage ?? null;
  const text =
    events.findLast((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')?.item
      ?.text ??
    events.findLast((e) => e.type === 'item.completed')?.item?.text ??
    '';

  if (!text) return cliFailure(out, 'unparseable');

  return {
    state: 'completed',
    text,
    finish_reason: 'stop',
    /**
     * ⚠⚠ NULL IS THE HONEST ANSWER, NOT ZERO. A subscription call has no
     * per-token price to report, and writing 0 would make it look free next to a
     * metered model in a cost column — which is how a routing card would come to
     * recommend the "cheapest" model on a number nobody measured. The card must
     * see `subscription` and decline to compare on cost.
     */
    cost_usd: null,
    cost_source: 'subscription',
    tokens: { in: usage?.input_tokens ?? null, out: usage?.output_tokens ?? null },
  };
}

/* ── Muse CLI (a Meta subscription) ─────────────────────────────────────── */

/**
 * ⚠⚠ NEVER A `-contributor` MODEL. The contributor tiers let Meta train on the
 * prompts and code sent to them. A bake-off prompt is a real project prompt, so
 * a contributor id is refused here, before anything is written or spawned. It is
 * checked on the model id rather than the `muse:` prefix because a task can also
 * name a model as `{ provider: 'muse', model }`, which skips the prefix path.
 */
export function isContributorModel(model) {
  return /-contributor/i.test(String(model ?? ''));
}

/* ⚠ A model id that starts with `-` would be read by the CLI as a flag. */
const flagLike = (s) => !s || String(s).startsWith('-');

const MUSE_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * ⚠⚠ `muse exec` IS AN AGENT TOO — SEE `viaCodex`. It is confined the same way,
 * with the flags `muse exec --help` offers:
 *
 *   --workspace <empty dir>   its file tools are rooted where there is nothing
 *   --disable-shell           no shell
 *   --disable-write           no file writes
 *   --disable-web-tools       no web fetch or search
 *   --approval-mode never     anything left that needs approval is not asked for
 *   --worktree off            no git worktree is created
 *   --no-session-log          the prompt is not written to the session log on disk
 *   --no-foreign-personal-context  none of the user's other rules or skills
 *
 * ⚠⚠ MCP SERVERS CANNOT BE DISABLED FOR A RUN — see `museMcpPreflight`, which
 * refuses to run when the user's Muse settings configure any.
 *
 * ⚠ THE PROMPT GOES IN A FILE, NOT ARGV. Prompts are long and `ps` shows argv.
 * `muse exec` has no stdin option for the prompt, so it is a file in a scratch
 * directory outside the workspace (so the model cannot read it), removed with it.
 *
 * ⚠ NO `--output-schema`. It is not passed, so a task with a `schema` must ask
 * for its format in the prompt. Untested against a live call, so left out.
 */
export function museArgv({ model, reasoning, workdir, promptFile }) {
  return [
    'exec',
    '--json',
    '--prompt-file',
    promptFile,
    '--model',
    model,
    ...(reasoning ? ['--reasoning-effort', reasoning] : []),
    '--workspace',
    workdir,
    '--worktree',
    'off',
    '--disable-shell',
    '--disable-write',
    '--disable-web-tools',
    '--approval-mode',
    'never',
    '--no-session-log',
    '--no-foreign-personal-context',
  ];
}

/**
 * ⚠ THE ANSWER IS THE TERMINAL EVENT'S `text`, NOT THE DELTAS. stdout is one JSON
 * event per line; `run.terminal.completed` carries the whole final answer. A run
 * that failed (a transport error after four retries still exits 1) has
 * `run.terminal.failed` and no text. Muse reports no token usage, so tokens stay
 * null. Returns `{ text, tokens }`, or `{ error }` with a failure category.
 */
export function parseMuseOutput(stdout) {
  const events = jsonLines(stdout);
  const end = events.findLast((e) => String(e.payload_type).startsWith('run.terminal.'));
  if (!end) return { error: 'unparseable' };
  if (end.payload_type !== 'run.terminal.completed') return { error: 'is_error' };
  const text = end.payload?.text;
  return typeof text === 'string' && text
    ? { text, tokens: { in: null, out: null } }
    : { error: 'unparseable' };
}

function jsonLines(stdout) {
  return (stdout ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * ⚠⚠ MUSE'S MCP SERVERS CANNOT BE SWITCHED OFF, SO THEY ARE CHECKED FOR.
 * `muse exec` has no flag or environment variable that disables MCP for a run
 * (`muse mcp` only logs in and out), and a configured server is reachable by the
 * model from outside the workspace confinement. So the call establishes an
 * MCP-free configuration before it spawns anything: it reads Muse's user
 * `settings.json`, walks every key, and refuses if any key matching /mcp/i holds
 * a non-empty value.
 *
 * The file is `$XDG_CONFIG_HOME/muse/settings.json`, else `~/.config/muse/`
 * (Muse's launcher honours `XDG_CONFIG_HOME`). The workspace is a fresh empty
 * `mkdtemp` directory, so there is no project-level Muse config to check.
 *
 * ⚠ ONLY `settings.json` IS READ. `auth.json` beside it is a credential and is
 * never opened. Setting values never reach an error, receipt or log: the result
 * is a category.
 *
 * ⚠ THE LIMIT OF THE CHECK: it covers the user file only. Enterprise-managed
 * policy or a config location this code does not know about is not seen. For
 * someone who accepts that, `MODEL_ROUTING_ALLOW_MUSE_MCP=1` skips the check and
 * the receipt records `mcp_check: 'skipped'`.
 */
export function museSettingsPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(base, 'muse', 'settings.json');
}

/** File text, or `null` when there is no file. Anything else throws. */
function readSettingsFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

const isEmptyValue = (v) =>
  v == null ||
  v === false ||
  v === 0 ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

function mentionsMcp(node) {
  if (node == null || typeof node !== 'object') return false;
  for (const [key, value] of Object.entries(node)) {
    if (/mcp/i.test(key) && !isEmptyValue(value)) return true;
    if (mentionsMcp(value)) return true;
  }
  return false;
}

/** `{ ok: true, mcp_check }` or `{ ok: false, error }` — a category, never a value. */
export function museMcpPreflight({ env = process.env, readSettings = readSettingsFile } = {}) {
  if (env.MODEL_ROUTING_ALLOW_MUSE_MCP === '1') return { ok: true, mcp_check: 'skipped' };
  let text;
  try {
    text = readSettings(museSettingsPath(env));
  } catch {
    return { ok: false, error: 'settings_unreadable' };
  }
  if (text == null) return { ok: true, mcp_check: 'passed' };
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    return { ok: false, error: 'settings_unreadable' };
  }
  return mentionsMcp(settings) ? { ok: false, error: 'mcp_configured' } : { ok: true, mcp_check: 'passed' };
}

function viaMuse({ model, prompt, reasoning, spawn = spawnSync, readSettings }) {
  if (isContributorModel(model)) {
    return {
      state: 'refused',
      error: `muse model "${model}" is a contributor tier: Meta may train on the prompts. Use the non-contributor model.`,
    };
  }
  if (flagLike(model)) return { state: 'refused', error: 'muse model id is empty or starts with "-"' };
  if (reasoning && !MUSE_EFFORTS.includes(reasoning)) {
    return { state: 'refused', error: `muse reasoning effort "${reasoning}" is not one of ${MUSE_EFFORTS.join('|')}` };
  }

  const mcp = museMcpPreflight({ readSettings });
  if (!mcp.ok) return { state: 'refused', error: mcp.error };

  const dirs = callDirs();
  let out;
  try {
    const promptFile = join(dirs.scratch, 'prompt.txt');
    writeFileSync(promptFile, prompt);
    out = spawn('muse', museArgv({ model, reasoning, workdir: dirs.workdir, promptFile }), {
      encoding: 'utf8',
      cwd: dirs.workdir,
      maxBuffer: 64 * 1024 * 1024,
      timeout: CLI_TIMEOUT_MS,
      killSignal: CLI_KILL_SIGNAL,
    });
  } finally {
    dirs.remove();
  }

  if (out.error) return cliFailure(out, spawnErrorCategory(out));

  /* ⚠ A non-zero exit is a failure even if some output text exists. */
  const parsed = out.status === 0 && !out.signal ? parseMuseOutput(out.stdout) : null;
  if (!parsed?.text) return cliFailure(out, exitCategory(out, parsed?.error));

  return {
    state: 'completed',
    text: parsed.text,
    finish_reason: 'stop',
    /* ⚠⚠ NULL, NOT ZERO — see the note on `viaCodex`. */
    cost_usd: null,
    cost_source: 'subscription',
    tokens: parsed.tokens,
    mcp_check: mcp.mcp_check,
  };
}

/* ── Claude Code CLI (a Claude subscription) ────────────────────────────── */

/**
 * ⚠⚠ THE CLAUDE SUBSCRIPTION IS USED THROUGH CLAUDE CODE ITSELF, AND ONLY THAT.
 * `claude -p` is Claude Code, so it is allowed. Nothing here reads a Claude
 * credential, replays it against another endpoint, or adds any other route.
 *
 * ⚠⚠ `claude -p` IS AN AGENT TOO — SEE `viaCodex`. `--tools ""` removes every
 * built-in tool, so it has no file, shell or web access to misuse. The rest keep
 * the call to just the prompt:
 *
 *   --no-session-persistence   nothing saved to disk or resumable
 *   --disable-slash-commands   no skills
 *   --strict-mcp-config        no MCP servers (none are passed, so none load)
 *   --setting-sources ""       no user, project or local settings, so none of
 *                              the user's hooks or permissions apply
 *
 * ⚠ KNOWN ASYMMETRY: `claude -p` STILL LOADS THE USER'S GLOBAL `CLAUDE.md` (in the Claude config directory).
 * The only flag that skips it is `--bare`, and `--bare` never reads the
 * subscription login (API-key billing only), so it cannot be used here. Muse
 * drops personal rules with `--no-foreign-personal-context`; Claude cannot. A
 * Claude bake-off prompt therefore carries the user's own instructions as well.
 *
 * ⚠ THE PROMPT GOES ON STDIN, NOT ARGV. Prompts are long and `ps` shows argv.
 *
 * ⚠ NO `--json-schema`. Not passed, so a task with a `schema` must ask for its
 * format in the prompt. Untested against a live call, so left out.
 */
export function claudeArgv({ model, reasoning }) {
  return [
    '--print',
    '--output-format',
    'json',
    '--model',
    model,
    ...(reasoning ? ['--effort', reasoning] : []),
    '--tools',
    '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--setting-sources',
    '',
  ];
}

/**
 * ⚠⚠ THE CHILD ENVIRONMENT IS AN ALLOWLIST, NOT "EVERYTHING EXCEPT THE API KEY".
 * The first version removed only `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`,
 * but other variables also move `claude -p` onto a metered backend:
 * `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`,
 * `ANTHROPIC_BASE_URL` and the cloud providers' own credentials (`AWS_*`,
 * `GOOGLE_*`, `AZURE_*`). Measured: `CLAUDE_CODE_USE_BEDROCK=1` alone changes
 * `claude auth status` to `third_party` / `bedrock`. A denylist has to know every
 * such name, now and in the next release; an allowlist only has to know what the
 * CLI needs to start. With this one the subscription login still reports
 * `claude.ai` / `firstParty`, so an allowlist was enough and no denylist is used.
 *
 * Kept: the basics a process needs, locale, proxy settings and CA certificates
 * (so it still works behind a proxy), and `CLAUDE_CODE_OAUTH_TOKEN`, which is the
 * subscription's own token for headless machines.
 */
const CLAUDE_ENV_ALLOW = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'SHELL',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

export function claudeEnv(base = process.env) {
  return Object.fromEntries(
    CLAUDE_ENV_ALLOW.filter((k) => base[k] !== undefined).map((k) => [k, base[k]]),
  );
}

/**
 * ⚠ `is_error` DECIDES, NOT THE EXIT CODE ALONE. A failed call (an API or proxy
 * error) still prints a result object whose `result` is the error message, so
 * reading `result` without checking `is_error` would score an error message as a
 * model answer.
 *
 * ⚠ The input count is everything the model read: `input_tokens` is only the
 * uncached part, and the system prompt arrives as cache tokens. `total_cost_usd`
 * is a list-price estimate, not a bill, and is deliberately ignored.
 *
 * Returns the answer, or `{ error }` with a failure category.
 */
export function parseClaudeOutput(stdout) {
  let body;
  try {
    body = JSON.parse(stdout);
  } catch {
    return { error: 'unparseable' };
  }
  if (body?.is_error === true) return { error: 'is_error' };
  if (body?.is_error !== false || typeof body.result !== 'string' || !body.result) {
    return { error: 'unparseable' };
  }
  const u = body.usage ?? {};
  const inTokens = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens];
  return {
    text: body.result,
    finish_reason: body.stop_reason === 'max_tokens' ? 'length' : 'stop',
    tokens: {
      in: inTokens.every((n) => typeof n !== 'number') ? null : inTokens.reduce((a, n) => a + (n ?? 0), 0),
      out: typeof u.output_tokens === 'number' ? u.output_tokens : null,
    },
  };
}

function viaClaude({ model, prompt, reasoning, spawn = spawnSync }) {
  if (flagLike(model)) return { state: 'refused', error: 'claude model id is empty or starts with "-"' };
  if (reasoning && !CLAUDE_EFFORTS.includes(reasoning)) {
    return { state: 'refused', error: `claude effort "${reasoning}" is not one of ${CLAUDE_EFFORTS.join('|')}` };
  }

  const dirs = callDirs();
  try {
    const env = claudeEnv();
    const common = {
      encoding: 'utf8',
      cwd: dirs.workdir,
      env,
      maxBuffer: 64 * 1024 * 1024,
      killSignal: CLI_KILL_SIGNAL,
    };

    /* ⚠⚠ ASK THE CLI HOW IT WILL AUTHENTICATE, AND REFUSE UNLESS IT IS THE
       SUBSCRIPTION. `claude auth status --json` is local and free (no model call),
       and it reads the same environment the real call gets. Measured: with
       `CLAUDE_CODE_USE_BEDROCK=1` it reports `apiProvider: "bedrock"` and
       `authMethod: "third_party"`; clean, `"claude.ai"` and `"firstParty"`. The
       env allowlist below should make a metered backend impossible, and this
       catches whatever the allowlist missed — a login that is not the
       subscription, a logged-out CLI, or a managed setting. Only those two fields
       are read; the account details in the same output are ignored.

       ⚠ It runs with the same allowlisted env and the same empty cwd as the real
       call. It does NOT get `--setting-sources ""`: `claude auth status --help`
       lists only `--json` and `--text`, so there is no such flag to pass. */
    const status = spawn('claude', ['auth', 'status', '--json'], {
      ...common,
      timeout: 30 * 1000,
    });
    if (!claudeIsSubscription(status)) {
      return { state: 'refused', error: 'auth_not_subscription' };
    }

    const out = spawn('claude', claudeArgv({ model, reasoning }), {
      ...common,
      input: prompt,
      timeout: CLI_TIMEOUT_MS,
    });

    if (out.error) return cliFailure(out, spawnErrorCategory(out));

    const parsed = out.status === 0 && !out.signal ? parseClaudeOutput(out.stdout) : null;
    if (!parsed?.text) return cliFailure(out, exitCategory(out, parsed?.error));

    return claudeEnvelope(parsed);
  } finally {
    dirs.remove();
  }
}

/**
 * ⚠ `oauth_token` IS THE SUBSCRIPTION TOO. With `CLAUDE_CODE_OAUTH_TOKEN` set
 * (the headless setup) `claude auth status` reports `authMethod: "oauth_token"`,
 * and refusing it would lock those users out. Both are accepted only with
 * `apiProvider: "firstParty"`. Everything else is refused: `third_party` with
 * Bedrock, Vertex or Foundry, an API-key method, or a logged-out CLI.
 */
const SUBSCRIPTION_AUTH_METHODS = ['claude.ai', 'oauth_token'];

function claudeIsSubscription(status) {
  if (status.error || status.status !== 0 || status.signal) return false;
  try {
    const s = JSON.parse(status.stdout);
    return (
      s?.loggedIn === true &&
      SUBSCRIPTION_AUTH_METHODS.includes(s.authMethod) &&
      s.apiProvider === 'firstParty'
    );
  } catch {
    return false;
  }
}

function claudeEnvelope(parsed) {
  return {
    state: 'completed',
    text: parsed.text,
    finish_reason: parsed.finish_reason,
    /* ⚠⚠ NULL, NOT ZERO — see the note on `viaCodex`. */
    cost_usd: null,
    cost_source: 'subscription',
    tokens: parsed.tokens,
  };
}

/* ── ChatGPT subscription, direct ───────────────────────────────────────── */

/**
 * ⚠⚠ THE SAME ROUTE `pi-imagen` USES, AND ITS WARNINGS COME WITH IT.
 *
 * `chatgpt.com/backend-api/codex/responses` is the hosted route local Codex
 * subscription sessions use. It is NOT the documented public OpenAI API and, in
 * pi-imagen's own words, "may change without notice". It exists here for one
 * reason: the `codex` CLI on this machine cannot decode the service's models
 * response any more (`unknown variant 'max'`), so the CLI path is dead while the
 * subscription itself is fine.
 *
 * ⚠ Prefer a documented API key for anything that must keep working. This is a
 * measurement tool; a broken measurement is cheap, a broken product is not.
 *
 * ⚠⚠ `~/.codex/auth.json` IS A PASSWORD. It is read here, sent only to
 * chatgpt.com, and never printed, copied or written into a receipt.
 */
function chatgptAuth() {
  const path = process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, 'auth.json')
    : join(homedir(), '.codex', 'auth.json');
  if (!existsSync(path)) throw new Error(`no ChatGPT credential at ${path}`);
  const auth = JSON.parse(readFileSync(path, 'utf8'));
  const token = auth.tokens?.access_token ?? auth.access_token;
  if (!token) throw new Error('no access_token in the ChatGPT credential');

  /* The account id is a claim inside the JWT, not a separate field. */
  let accountId = auth.tokens?.account_id ?? auth.account_id ?? null;
  if (!accountId) {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf8',
      ),
    );
    accountId =
      payload['https://api.openai.com/auth']?.chatgpt_account_id ?? payload.chatgpt_account_id;
  }
  if (!accountId) throw new Error('could not resolve chatgpt_account_id');
  return { token, accountId };
}

async function viaChatGPT({ model, prompt, schema }) {
  const { token, accountId } = chatgptAuth();
  const body = {
    model,
    store: false,
    stream: true,
    instructions:
      'Answer the request directly. Return no preamble, no explanation and no code fence.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    text: schema
      ? { verbosity: 'low', format: { type: 'json_schema', ...(schema.schema ? schema : { schema }) } }
      : { verbosity: 'low' },
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: 'low', summary: 'auto' },
  };

  const res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'ChatGPT-Account-ID': accountId,
      originator: 'model-routing',
      'OpenAI-Beta': 'responses=experimental',
      accept: 'text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    /* ⚠ Status only — the body can echo the request, token included. */
    return { state: 'http_error', status: res.status };
  }

  /* Server-sent events: accumulate text deltas, keep the final usage. */
  let text = '';
  let usage = null;
  const raw = await res.text();
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') text += ev.delta;
    if (ev.type === 'response.completed') {
      usage = ev.response?.usage ?? usage;
      if (!text) {
        const out = ev.response?.output ?? [];
        for (const item of out) {
          for (const c of item.content ?? []) {
            if (typeof c.text === 'string') text += c.text;
          }
        }
      }
    }
  }

  if (!text) return { state: 'no_output' };

  return {
    state: 'completed',
    text,
    finish_reason: 'stop',
    /* ⚠ NULL, NOT ZERO — see the note on the codex provider. A subscription call
       has no per-token price, and 0 would make it look free in a cost column. */
    cost_usd: null,
    cost_source: 'subscription',
    tokens: { in: usage?.input_tokens ?? null, out: usage?.output_tokens ?? null },
  };
}

/**
 * `spawn` replaces `spawnSync` for the CLI providers. It exists so tests can
 * answer for the binary: a test must never run the real `codex`, `muse` or
 * `claude`, because each one is a model call on a subscription.
 */
export async function call(spec, { prompt, schema, key, spawn, readSettings }) {
  if (spec.provider === 'codex') return guardCli(() => viaCodex({ model: spec.model, prompt, schema, spawn }));
  if (spec.provider === 'muse')
    return guardCli(() =>
      viaMuse({ model: spec.model, prompt, reasoning: spec.reasoning, spawn, readSettings }),
    );
  if (spec.provider === 'claude')
    return guardCli(() => viaClaude({ model: spec.model, prompt, reasoning: spec.reasoning, spawn }));
  if (spec.provider === 'chatgpt') return viaChatGPT({ model: spec.model, prompt, schema });
  if (spec.provider === 'openrouter')
    return viaOpenRouter({ model: spec.model, prompt, schema, key });
  if (spec.provider === 'subconscious')
    return viaSubconscious({ model: spec.model, prompt, schema, key });
  throw new Error(`unknown provider "${spec.provider}"`);
}

/**
 * ⚠⚠ AN EXCEPTION IS NOT ALLOWED TO CARRY ITS MESSAGE OUT. A throw from inside a
 * CLI provider (a spawn that failed oddly, a full disk) has a message the code
 * did not write, and it can contain a path, an account or an echo of the request.
 * Every CLI provider body runs inside this, and the result is the category only.
 */
function guardCli(run) {
  try {
    return run();
  } catch {
    return { state: 'threw', error: 'spawn_failed' };
  }
}

/** Which providers in this task need a paid key before anything is sent. */
export function needsKey(specs) {
  return keyNames(specs).length > 0;
}

/**
 * Which environment variable each provider's credential lives in — `null` for a
 * provider whose auth belongs to a CLI.
 *
 * ⚠⚠ ONE KEY FOR ALL PROVIDERS WAS THE OLD ASSUMPTION, AND IT ONLY HELD WHILE
 * THERE WAS ONE GATEWAY. A card comparing a model on OpenRouter against one on
 * Subconscious needs both, and handing the wrong one over sends one provider's
 * credential to another — which comes back as an auth failure and reads as a bad
 * key rather than the wrong key.
 */
export function keyNameFor(provider) {
  return (
    { openrouter: 'OPENROUTER_API_KEY', subconscious: 'SUBCONSCIOUS_API_KEY' }[provider] ??
    null
  );
}

/** The distinct credential names these specs need, in order. */
export function keyNames(specs) {
  const out = [];
  for (const s of specs) {
    const name = keyNameFor(s.provider);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
