#!/usr/bin/env node
/**
 * Installed entry point: `model-routing run|card <task.mjs> [flags]`.
 *
 * ⚠ A thin wrapper, not a second implementation. `run` and `card` spawn the
 * same `scripts/route.mjs` with the same args and inherit its stdio and exit
 * code, so the installed CLI cannot drift from `node scripts/route.mjs`.
 * Commands remain entries in COMMANDS.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadPolicy, loadOverride, repoKey, machineIds, parseUniqueJson } from '../scripts/policy.mjs';
import { pick } from '../scripts/pick.mjs';
import { loadLocalConfig, localConfigStatus } from '../scripts/local-config.mjs';
import { loadEffectivePolicy, exportLocal } from '../scripts/policy-local.mjs';
import { findCard } from '../scripts/cards.mjs';
import { classify } from '../scripts/classify.mjs';
import { readQuota, buildSpawn, buildApproval } from '../scripts/adapters/bb.mjs';
import { stateDirectory, readState, readStateLog, logDecision, setLimit, withStateLock } from '../scripts/state.mjs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(here, '..', 'scripts', 'route.mjs');
const VERSION = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8')).version;

const USAGE = `usage: model-routing <command> [args]

  run <task.mjs> [flags]    execute the bake-off, write receipts (dry by default)
  card <task.mjs> [flags]   aggregate receipts into a routing card

  pick [flags]            choose a worker; classification is dry without --execute
  limit <route> [--hours N] mark a route temporarily unavailable
  record <decision-id>     record verified work (Jev is dry without --execute)
  outcomes [--kind K] [--json] show field outcomes and bake-off readiness
  policy show [--json]     print the merged policy and which local files were loaded
  policy export-local --from OLD.json
                           print a policy.local.json from an older policy file (no writes)

pick: --brief-file F | --brief TEXT, --kind K, --repo DIR, --machine ID,
      --failures N, --author ROUTE_OR_VENDOR, --author-model MODEL (repeatable), --main-thread, --project ID,
      --section ID, --title T, --prompt-file F, --execute, --no-quota,
      --jev-limit-usd N (default 0.01), --cards-dir DIR, --require-quota, --spend-approved ROUTE[,ROUTE...], --json
limit: --hours N (default from policy, otherwise 5), --json
record: --result pass|fail|partial|abandoned, --gate name=pass|fail (repeatable),
        --gates-file F.json, --failures-before N, --notes TEXT (max 500 characters),
        --brief-file F --result-file R --execute, --jev-limit-usd N (default 0.01)

run and card behave exactly like \`node scripts/route.mjs run|card ...\`.
Receipts are written beside the task file. Cards use that location or --out DIR.
`;

/* ⚠ Keep command dispatch in one table so installed and direct use agree. */
export const COMMANDS = {
  pick: runPick,
  limit: runLimit,
  record: runRecord,
  outcomes: runOutcomes,
  policy: runPolicy,
  run: (args) => execRoute(['run', ...args]),
  card: (args) => execRoute(['card', ...args]),
};

function execRoute(args) {
  const r = spawnSync(process.execPath, [ROUTE, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

/** The policy every command routes with: public policy plus the user's local overlay. */
const activePolicy = deps => deps.loadPolicy ? deps.loadPolicy() : loadEffectivePolicy({ env: deps.env ?? process.env }).policy;

const pickOptions = {
  'brief-file': { type: 'string' }, brief: { type: 'string' }, kind: { type: 'string' },
  repo: { type: 'string' }, machine: { type: 'string' }, failures: { type: 'string' },
  author: { type: 'string' }, 'author-model': { type: 'string', multiple: true }, 'main-thread': { type: 'boolean' }, project: { type: 'string' },
  section: { type: 'string' }, title: { type: 'string' }, 'prompt-file': { type: 'string' },
  execute: { type: 'boolean' }, 'no-quota': { type: 'boolean' }, json: { type: 'boolean' },
  'jev-limit-usd': { type: 'string' }, 'cards-dir': { type: 'string' }, 'require-quota': { type: 'boolean' }, 'spend-approved': { type: 'string' },
};
function number(value, label, fallback, integer = false) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
    throw new TypeError(`${label} must be a nonnegative ${integer ? 'integer' : 'number'}`);
  }
  return parsed;
}
function present(decision, json) {
  if (json) return JSON.stringify(decision, null, 2) + '\n';
  return `${decision.status}: ${decision.route ?? decision.reason ?? 'no route'}${decision.machine ? ` on ${decision.machine}` : ''}${decision.basis ? ` (${decision.basis})` : ''}\n`
    + (Object.hasOwn(decision, 'costPer1M') ? `Cost per 1M tokens (USD): in ${decision.costPer1M?.in ?? 'unknown'}, out ${decision.costPer1M?.out ?? 'unknown'}; spend approved: ${decision.spendApproved}\n` : '')
    + decision.beforeSpawn.map(step => `before spawn: ${step}\n`).join('')
    + decision.notes.map(note => `! ${note}\n`).join('')
    + decision.why.map(reason => `- ${reason}\n`).join('')
    + (decision.instruction ? `${decision.instruction}\nSpend approval required: ${decision.requiresSpendApproval}\n` : '')
    + (decision.approval ? `approval preview (rerun pick after approval): ${JSON.stringify(decision.approval)}\n` : '')
    + (decision.spawn ? `spawn: ${JSON.stringify(decision.spawn.argv)}\nmissing: ${decision.spawn.missing.join(', ') || 'none'}\n` : '');
}

/** Inject commands, files, classifier and state location for entirely offline CLI tests. */
export async function runPick(args, deps = {}) {
  let flags;
  try { ({ values: flags } = parseArgs({ args, options: pickOptions, allowPositionals: false })); }
  catch (error) {
    if (error.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && error.message.includes('--spend-approved')) {
      throw new TypeError('--spend-approved: name the approved route (or comma-separated routes)');
    }
    throw error;
  }
  const policy = activePolicy(deps);
  if (flags.brief !== undefined && flags['brief-file'] !== undefined) throw new TypeError('Use --brief or --brief-file, not both');
  for (const [flag, value] of Object.entries(flags)) if (typeof value === 'string' && !value.trim()) throw new TypeError(`--${flag} needs a nonempty value`);
  if (flags.kind !== undefined && !Object.hasOwn(policy.kinds, flags.kind)) throw new TypeError(`Unknown kind: ${flags.kind}`);
  if (flags.machine !== undefined && !machineIds(policy).includes(flags.machine)) throw new TypeError(`Unknown machine: ${flags.machine}`);
  if (flags.author !== undefined && !Object.hasOwn(policy.routes, flags.author)
    && !Object.values(policy.routes).some(route => route.vendor === flags.author)) throw new TypeError('Unknown author route or vendor');
  const approvedRoutes = flags['spend-approved'] === undefined ? [] : [...new Set(flags['spend-approved'].split(',').map(route => route.trim()))];
  if (approvedRoutes.some(route => !route || !Object.hasOwn(policy.routes, route))) {
    throw new TypeError('--spend-approved: name the approved route; every entry must be a known route');
  }
  const failures = number(flags.failures, '--failures', 0, true);
  const limitUsd = number(flags['jev-limit-usd'], '--jev-limit-usd', 0.01);
  const repoDir = resolve(flags.repo ?? deps.cwd ?? process.cwd());
  const repo = (deps.repoKey ?? repoKey)(repoDir);
  const override = (deps.loadOverride ?? loadOverride)(repoDir);
  const { error: localConfigError, ...localConfig } = (deps.loadLocalConfig ?? loadLocalConfig)(policy, { env: deps.env ?? process.env });
  const brief = flags['brief-file'] === undefined ? flags.brief : (deps.readFile ?? readFileSync)(resolve(flags['brief-file']), 'utf8');
  const input = { kind: flags.kind, execute: flags.execute, failures, machine: flags.machine,
    approvedRoutes, requireQuota: flags['require-quota'], author: flags.author, authorModels: flags['author-model'], mainThread: flags['main-thread'], project: flags.project,
    section: flags.section, title: flags.title, promptFile: flags['prompt-file'] };
  // ⚠ A local quota read is free; --execute authorizes classification only, never dispatch.
  const quota = flags['no-quota'] ? null : await (deps.readQuota ?? readQuota)();
  const classifier = flags.kind ? undefined : brief?.trim()
    ? await (deps.classify ?? classify)({ brief, execute: flags.execute, limitUsd }, { policy })
    : { status: 'needs_kind', reason: 'missing_brief', confidence: null, top: [], costUsd: 0 };
  const cards = {};
  const kind = flags.kind ?? classifier?.kind;
  const cardFile = policy.cards.byKind[kind];
  const found = cardFile ? findCard(cardFile, { cardsDir: flags['cards-dir'], repoDir,
    env: deps.env ?? process.env, readFile: deps.readFile ?? readFileSync }) : { why: [] };
  if (found.card) cards[kind] = found.card;
  const dir = deps.stateDir ?? stateDirectory();
  const decision = await withStateLock(dir, () => {
    const now = deps.now ?? new Date();
    const state = readState(dir, policy);
    const decision = pick(input, { policy, repo, override, quota, classifier, cards, localConfig, localConfigError, ...state, now,
      id: `dec_${new Date(now).getTime()}_${randomUUID().slice(0, 8)}` });
    decision.why.push(...found.why);
    if (state.unreadableLogLines) decision.notes.push(`skipped ${state.unreadableLogLines} unreadable log lines`);
    const spawn = buildSpawn(decision, input);
    if (spawn) decision.spawn = spawn;
    const approval = buildApproval(decision, input);
    if (approval) Object.assign(decision, { spawn: null, approval });
    return logDecision(dir, decision, brief);
  });
  (deps.stdout ?? (text => process.stdout.write(text)))(present(decision, flags.json || !(deps.isTTY ?? process.stdout.isTTY)));
  return { ok: 0, external: 0, needs_approval: 5, needs_kind: 3, blocked: 4 }[decision.status];
}

function describeSources({ sources, effects, local }) {
  const names = ids => ids.length ? ids.join(', ') : 'none';
  const state = { loaded: 'loaded', absent: 'not found', error: 'ERROR' };
  return `Policy: ${sources.policy}\n`
    + `Local overlay: ${sources.overlay.file} (${sources.overlay.loaded ? 'loaded' : 'not found'})\n`
    + `Local models: ${local.file} (${state[local.state]}${local.error ? `: ${local.error}` : ''})\n`
    + `Local overlay changes:\n`
    + `  repo rules: ${names(effects.repos.map(r => r.replacesPublic ? `${r.repo} (replaces public entry)` : r.repo))}\n`
    + `  route notes: ${names(effects.routeNotes)}\n`
    + `  kind descriptions: ${names(effects.kindDescriptions)}\n`
    + `  instruction overrides: ${names(effects.instructions)}\n`
    + 'Use --json for the full merged policy.\n';
}

export async function runPolicy(args, deps = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { json: { type: 'boolean' }, from: { type: 'string' } } });
  const [sub, ...extra] = positionals;
  const stdout = deps.stdout ?? (text => process.stdout.write(text));
  if (extra.length || !['show', 'export-local'].includes(sub)) throw new TypeError('usage: policy show [--json] | policy export-local --from OLD.json');
  if (sub === 'show') {
    if (values.from !== undefined) throw new TypeError('policy show does not take --from');
    const env = deps.env ?? process.env;
    const result = loadEffectivePolicy({ env, readFile: deps.readFile });
    const local = localConfigStatus(result.policy, { env, readFile: deps.readFile });
    stdout(values.json ? JSON.stringify({ sources: { ...result.sources, localModels: local }, effects: result.effects, policy: result.policy }, null, 2) + '\n'
      : describeSources({ ...result, local }));
    return 0;
  }
  if (values.json) throw new TypeError('policy export-local always prints JSON; omit --json');
  if (!values.from?.trim()) throw new TypeError('policy export-local needs --from OLD_POLICY.json');
  let old;
  const file = resolve(values.from);
  try { old = parseUniqueJson((deps.readFile ?? readFileSync)(file, 'utf8')); }
  catch (error) { throw new TypeError(`${file}: could not be read as a policy file (${error.code ?? error.message})`); }
  // ⚠ Export against the public policy only, so a local overlay already in place cannot leak into its own migration.
  const { overlay, skipped } = exportLocal(old, loadPolicy());
  const counts = Object.entries(overlay).filter(([key]) => key !== 'policyVersion').map(([key, value]) => `${Object.keys(value).length} ${key}`);
  (deps.stderr ?? (text => process.stderr.write(text)))(`exported ${counts.join(', ') || 'nothing'}\n`
    + skipped.map(path => `differs for other reasons: ${path}\n`).join(''));
  stdout(JSON.stringify(overlay, null, 2) + '\n');
  return 0;
}

export async function runLimit(args, deps = {}) {
  const { values, positionals } = parseArgs({ args, options: { hours: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: true });
  const policy = activePolicy(deps);
  const [route] = positionals;
  if (positionals.length !== 1 || !Object.hasOwn(policy.routes, route) || policy.routes[route].type === 'external') throw new TypeError('limit needs one worker route');
  const hours = number(values.hours, '--hours', policy.quota.limitErrors.find(rule => rule.route === route)?.cooldownHours ?? 5);
  if (hours <= 0 || hours > 87600) throw new TypeError('--hours must be greater than 0 and at most 87600');
  const dir = deps.stateDir ?? stateDirectory();
  const result = await withStateLock(dir, () => setLimit(dir, route, hours, deps.now ?? new Date()));
  (deps.stdout ?? (text => process.stdout.write(text)))(JSON.stringify(result) + '\n');
  return 0;
}

export async function runRecord(args, deps = {}) {
  const { values: flags, positionals } = parseArgs({ args, allowPositionals: true, options: {
    result: { type: 'string' }, gate: { type: 'string', multiple: true },
    'gates-file': { type: 'string' }, 'failures-before': { type: 'string' }, notes: { type: 'string' },
    'brief-file': { type: 'string' }, 'result-file': { type: 'string' },
    execute: { type: 'boolean' }, 'jev-limit-usd': { type: 'string' },
  } });
  if (positionals.length !== 1 || !positionals[0].trim()) throw new TypeError('record needs one decision id');
  // ⚠ Only record/outcomes load this module; routing and cards cannot consume field evidence.
  const { recordOutcome, validateGates } = await import('../scripts/outcomes.mjs');
  let gates = {};
  if (flags['gates-file'] !== undefined) {
    let parsed;
    // ⚠ Parser diagnostics may include file contents; expose only a fixed message.
    try { parsed = JSON.parse((deps.readFile ?? readFileSync)(resolve(flags['gates-file']), 'utf8')); }
    catch { throw new TypeError('gates file is not valid JSON'); }
    gates = validateGates(parsed);
  }
  for (const flag of flags.gate ?? []) {
    const match = /^([a-zA-Z0-9_.-]+)=(pass|fail)$/.exec(flag);
    if (!match) throw new TypeError('--gate must be name=pass or name=fail');
    const [, name, value] = match;
    if (Object.hasOwn(gates, name) && gates[name] !== value) throw new TypeError(`Conflicting results for gate ${name}`);
    Object.defineProperty(gates, name, { value, enumerable: true, configurable: true });
  }
  const record = await recordOutcome({ decisionId: positionals[0], result: flags.result, gates,
    failuresBefore: number(flags['failures-before'], '--failures-before', 0, true), notes: flags.notes,
    execute: flags.execute, briefFile: flags['brief-file'], resultFile: flags['result-file'],
    limitUsd: number(flags['jev-limit-usd'], '--jev-limit-usd', 0.01),
  }, { ...deps, stateDir: deps.stateDir ?? stateDirectory() });
  (deps.stdout ?? (text => process.stdout.write(text)))(JSON.stringify(record) + '\n');
  return 0;
}

export async function runOutcomes(args, deps = {}) {
  const { values } = parseArgs({ args, allowPositionals: false,
    options: { kind: { type: 'string' }, json: { type: 'boolean' } } });
  const policy = activePolicy(deps);
  if (values.kind !== undefined && !Object.hasOwn(policy.kinds, values.kind)) throw new TypeError(`Unknown kind: ${values.kind}`);
  const { summarizeOutcomes, formatOutcomes } = await import('../scripts/outcomes.mjs');
  const dir = deps.stateDir ?? stateDirectory();
  const summary = await withStateLock(dir, () => {
    const decisions = readStateLog(dir, 'decisions.jsonl');
    const outcomes = readStateLog(dir, 'outcomes.jsonl');
    const summary = summarizeOutcomes(decisions.records, outcomes.records, policy, values.kind);
    summary.unreadableLogLines.decisions += decisions.unreadableLogLines;
    summary.unreadableLogLines.outcomes += outcomes.unreadableLogLines;
    return summary;
  });
  (deps.stdout ?? (text => process.stdout.write(text)))(values.json ? JSON.stringify(summary, null, 2) + '\n' : formatOutcomes(summary));
  return 0;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  if (!argv.length || ['help', '--help'].includes(argv[0])) { process.stdout.write(USAGE); return 0; }
  if (argv[0] === '--version') { console.log(VERSION); return 0; }
  const command = Object.hasOwn(COMMANDS, argv[0]) ? COMMANDS[argv[0]] : undefined;
  if (!command) { process.stderr.write(USAGE); return 2; }
  try { return await command(argv.slice(1), deps); }
  catch (error) {
    (deps.stderr ?? (text => process.stderr.write(text)))(`${error.message}\n`);
    return 2;
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
