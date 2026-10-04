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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadPolicy, loadOverride, repoKey } from '../scripts/policy.mjs';
import { pick } from '../scripts/pick.mjs';
import { classify } from '../scripts/classify.mjs';
import { readQuota, buildSpawn } from '../scripts/adapters/bb.mjs';
import { stateDirectory, readState, logDecision, setLimit, withStateLock } from '../scripts/state.mjs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(here, '..', 'scripts', 'route.mjs');
const VERSION = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8')).version;

const USAGE = `usage: model-routing <command> [args]

  run <task.mjs> [flags]    execute the bake-off, write receipts (dry by default)
  card <task.mjs> [flags]   aggregate receipts into a routing card

  pick [flags]            choose a worker; classification is dry without --execute
  limit <route> [--hours N] mark a route temporarily unavailable

pick: --brief-file F | --brief TEXT, --kind K, --repo DIR, --machine ID,
      --failures N, --author ROUTE_OR_VENDOR, --main-thread, --project ID,
      --section ID, --title T, --prompt-file F, --execute, --no-quota,
      --jev-limit-usd N (default 0.01), --json
limit: --hours N (default from policy, otherwise 5), --json
record is coming in a later release.

run and card behave exactly like \`node scripts/route.mjs run|card ...\`.
Receipts and cards are written beside the task file, never inside the install.
`;

/* ⚠ One entry per command: a later PR adds `pick` / `record` here and nowhere
   else. Each entry receives the args after the command name. */
export const COMMANDS = {
  pick: runPick,
  limit: runLimit,
  run: (args) => execRoute(['run', ...args]),
  card: (args) => execRoute(['card', ...args]),
};

function execRoute(args) {
  const r = spawnSync(process.execPath, [ROUTE, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const pickOptions = {
  'brief-file': { type: 'string' }, brief: { type: 'string' }, kind: { type: 'string' },
  repo: { type: 'string' }, machine: { type: 'string' }, failures: { type: 'string' },
  author: { type: 'string' }, 'main-thread': { type: 'boolean' }, project: { type: 'string' },
  section: { type: 'string' }, title: { type: 'string' }, 'prompt-file': { type: 'string' },
  execute: { type: 'boolean' }, 'no-quota': { type: 'boolean' }, json: { type: 'boolean' },
  'jev-limit-usd': { type: 'string' },
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
    + decision.why.map(reason => `- ${reason}\n`).join('')
    + (decision.instruction ? `${decision.instruction}\nSpend approval required: ${decision.requiresSpendApproval}\n` : '')
    + (decision.spawn ? `spawn: ${JSON.stringify(decision.spawn.argv)}\nmissing: ${decision.spawn.missing.join(', ') || 'none'}\n` : '');
}

/** Inject commands, files, classifier and state location for entirely offline CLI tests. */
export async function runPick(args, deps = {}) {
  const { values: flags } = parseArgs({ args, options: pickOptions, allowPositionals: false });
  const policy = (deps.loadPolicy ?? loadPolicy)();
  if (flags.brief !== undefined && flags['brief-file'] !== undefined) throw new TypeError('Use --brief or --brief-file, not both');
  for (const [flag, value] of Object.entries(flags)) if (typeof value === 'string' && !value.trim()) throw new TypeError(`--${flag} needs a nonempty value`);
  if (flags.kind !== undefined && !Object.hasOwn(policy.kinds, flags.kind)) throw new TypeError(`Unknown kind: ${flags.kind}`);
  if (flags.machine !== undefined && !Object.hasOwn(policy.machines, flags.machine)) throw new TypeError(`Unknown machine: ${flags.machine}`);
  if (flags.author !== undefined && !Object.hasOwn(policy.routes, flags.author)
    && !Object.values(policy.routes).some(route => route.vendor === flags.author)) throw new TypeError('Unknown author route or vendor');
  const failures = number(flags.failures, '--failures', 0, true);
  const limitUsd = number(flags['jev-limit-usd'], '--jev-limit-usd', 0.01);
  const repoDir = resolve(flags.repo ?? deps.cwd ?? process.cwd());
  const repo = (deps.repoKey ?? repoKey)(repoDir);
  const override = (deps.loadOverride ?? loadOverride)(repoDir);
  const brief = flags['brief-file'] === undefined ? flags.brief : (deps.readFile ?? readFileSync)(resolve(flags['brief-file']), 'utf8');
  const input = { kind: flags.kind, execute: flags.execute, failures, machine: flags.machine,
    author: flags.author, mainThread: flags['main-thread'], project: flags.project,
    section: flags.section, title: flags.title, promptFile: flags['prompt-file'] };
  // ⚠ A local quota read is free; --execute authorizes classification only, never dispatch.
  const quota = flags['no-quota'] ? null : await (deps.readQuota ?? readQuota)();
  const classifier = flags.kind ? undefined : brief?.trim()
    ? await (deps.classify ?? classify)({ brief, execute: flags.execute, limitUsd }, { policy })
    : { status: 'needs_kind', reason: 'missing_brief', confidence: null, top: [], costUsd: 0 };
  const cards = {};
  const kind = flags.kind ?? classifier?.kind;
  const cardFile = policy.cards.byKind[kind];
  let cardError;
  if (cardFile) {
    try { cards[kind] = JSON.parse((deps.readFile ?? readFileSync)(resolve(here, '..', cardFile), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') cardError = `card ${kind} unreadable or malformed, ignored`; }
  }
  const dir = deps.stateDir ?? stateDirectory();
  const decision = await withStateLock(dir, () => {
    const now = deps.now ?? new Date();
    const state = readState(dir);
    const decision = pick(input, { policy, repo, override, quota, classifier, cards, ...state, now,
      id: `dec_${new Date(now).getTime()}_${randomUUID().slice(0, 8)}` });
    if (cardError) decision.why.push(cardError);
    const spawn = buildSpawn(decision, input);
    if (spawn) decision.spawn = spawn;
    return logDecision(dir, decision, brief);
  });
  (deps.stdout ?? (text => process.stdout.write(text)))(present(decision, flags.json || !(deps.isTTY ?? process.stdout.isTTY)));
  return { ok: 0, external: 0, needs_kind: 3, blocked: 4 }[decision.status];
}

export async function runLimit(args, deps = {}) {
  const { values, positionals } = parseArgs({ args, options: { hours: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: true });
  const policy = (deps.loadPolicy ?? loadPolicy)();
  const [route] = positionals;
  if (positionals.length !== 1 || !Object.hasOwn(policy.routes, route) || policy.routes[route].type === 'external') throw new TypeError('limit needs one worker route');
  const hours = number(values.hours, '--hours', policy.quota.limitErrors.find(rule => rule.route === route)?.cooldownHours ?? 5);
  if (hours <= 0 || hours > 87600) throw new TypeError('--hours must be greater than 0 and at most 87600');
  const dir = deps.stateDir ?? stateDirectory();
  const result = await withStateLock(dir, () => setLimit(dir, route, hours, deps.now ?? new Date()));
  (deps.stdout ?? (text => process.stdout.write(text)))(JSON.stringify(result) + '\n');
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
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
