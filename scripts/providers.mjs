/**
 * Where a model call actually goes.
 *
 * ⚠⚠ A ROUTING TOOL THAT KNOWS ONE GATEWAY IS NOT A ROUTING TOOL. The first
 * version spoke only OpenRouter, which made "use my OpenAI subscription instead"
 * unanswerable — and a subscription is not a cheaper OpenRouter, it is a
 * different shape: the auth belongs to a CLI, and there is no per-token cost to
 * report at all.
 *
 * Two providers today. Each returns the same envelope so the scorer and the
 * trust gate never learn which one ran.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

/** `{provider, model}` from either a bare slug or an explicit object. */
export function parseModel(entry) {
  if (typeof entry === 'string') {
    for (const [prefix, provider] of [
      ['codex:', 'codex'],
      ['chatgpt:', 'chatgpt'],
      ['subconscious:', 'subconscious'],
    ]) {
      if (entry.startsWith(prefix)) {
        return { provider, model: entry.slice(prefix.length), label: entry };
      }
    }
    return { provider: 'openrouter', model: entry, label: entry };
  }
  return {
    provider: entry.provider ?? 'openrouter',
    model: entry.model,
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
 * what the docs call it — a wedding-repo sprint lost an end-to-end run to this.
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
 * ⚠ STABLE, NOT FRESH-PER-CALL. The CLI puts the working directory into the
 * model's context, so a new temp path per call changes the prompt prefix and
 * throws the cache away — measured in the wedding repo as cached input falling
 * from 19,840 to 2,432 tokens the moment confinement used `mkdtemp`. One fixed
 * empty directory confines exactly as well and keeps the prefix byte-identical.
 */
function emptyWorkdir() {
  const dir = join(tmpdir(), 'model-routing-workdir');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function viaCodex({ model, prompt, schema }) {
  const workdir = emptyWorkdir();
  let schemaPath = null;
  if (schema) {
    schemaPath = join(tmpdir(), `model-routing-schema-${process.pid}.json`);
    writeFileSync(schemaPath, JSON.stringify(schema.schema ?? schema));
  }

  /**
   * ⚠⚠ `codex exec` IS AN AGENT, NOT A COMPLETION, AND THAT COST REAL MONEY.
   * Run inside a repo it goes exploring: one call in the wedding repo returned a
   * tree describing that repo's git state instead of answering the brief, at
   * roughly 24× a normal call's tokens, because it had been reading the working
   * tree. A budget ceiling cannot catch that — it is checked BEFORE the call.
   *
   * So the call is confined rather than trusted. An empty `--cd` gives it
   * nothing to read; `--sandbox read-only` stops model-generated commands
   * writing. Both matter, and the prompt already carries everything it needs.
   */
  const out = spawnSync(
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
    { input: prompt, encoding: 'utf8', cwd: workdir, maxBuffer: 64 * 1024 * 1024 },
  );

  if (out.error) return { state: 'threw', error: String(out.error).slice(0, 160) };

  /**
   * ⚠ THE EVENT STREAM IS ON STDOUT AND THE NOISE IS ON STDERR. The CLI dumps a
   * models catalogue to stderr at startup which contains the word `usage` and
   * whole JSON objects; a probe that searched both streams matched the dump and
   * read a wrong number confidently. Parse stdout, line by line, by event type.
   */
  const events = (out.stdout ?? '')
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

  const usage = events.findLast((e) => e.type === 'turn.completed')?.usage ?? null;
  const text =
    events.findLast((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')?.item
      ?.text ??
    events.findLast((e) => e.type === 'item.completed')?.item?.text ??
    '';

  if (!text) {
    return { state: 'no_output', error: (out.stderr ?? '').slice(0, 200) };
  }

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

export async function call(spec, { prompt, schema, key }) {
  if (spec.provider === 'codex') return viaCodex({ model: spec.model, prompt, schema });
  if (spec.provider === 'chatgpt') return viaChatGPT({ model: spec.model, prompt, schema });
  if (spec.provider === 'openrouter')
    return viaOpenRouter({ model: spec.model, prompt, schema, key });
  if (spec.provider === 'subconscious')
    return viaSubconscious({ model: spec.model, prompt, schema, key });
  throw new Error(`unknown provider "${spec.provider}"`);
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
