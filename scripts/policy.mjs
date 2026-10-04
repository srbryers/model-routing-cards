/** Policy data and deterministic candidate expansion. No probes, quota reads or credentials. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TRUST } from './card.mjs';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const KIND_IDS = [
  'bounded-build', 'quick-edit', 'write-tests', 'docs', 'scouting', 'first-pass-review',
  'simple-bug-fix', 'multi-step-coding', 'migration', 'hard-bug-fix', 'ci-terminal',
  'routine-review', 'skill-workflow', '3d-work', 'ui-visual', 'ios', 'architecture',
  'high-risk-review', 'data-contract', 'bulk-text', 'image-generation',
];
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => object(o) && Object.hasOwn(o, k);
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;
const sonnet = (id, route) => id === 'sonnet' || /sonnet/i.test(route?.model ?? '');
const muse = (id, route) => id === 'muse' || route?.provider === 'acp-muse';

function checks(errors) {
  const check = (condition, message) => { if (!condition) errors.push(message); };
  const fields = (value, path, required, optional = []) => {
    if (!object(value)) { errors.push(`${path} must be an object`); return false; }
    for (const key of required) check(has(value, key), `${path}.${key} is required`);
    for (const key of Object.keys(value)) {
      check([...required, ...optional].includes(key), `${path}.${key} is not supported`);
    }
    return true;
  };
  const list = (value, path, allowed, min = 0) => {
    if (!Array.isArray(value)) { errors.push(`${path} must be an array`); return []; }
    check(value.length >= min, `${path} must contain at least ${min} item(s)`);
    check(new Set(value).size === value.length, `${path} contains duplicates`);
    for (const id of value) check(allowed.includes(id), `${path}: unknown id ${String(id)}`);
    return value;
  };
  const reasoning = (value, path, nullable = false) => {
    check(LEVELS.includes(value) || (nullable && value === null),
      `${path} must be ${LEVELS.join('|')}${nullable ? ' or null' : ''}`);
  };
  return { check, fields, list, reasoning };
}

function capFor(id, route) {
  // ⚠ A renamed Sonnet route must not bypass its token-use cap.
  return sonnet(id, route) ? 'high' : route?.maxReasoning;
}

function checkRouteReasoning(ids, level, routes, path, check) {
  for (const id of ids) {
    if (!has(routes, id) || level === null) continue;
    const cap = capFor(id, routes[id]);
    check(!cap || LEVELS.indexOf(level) <= LEVELS.indexOf(cap),
      `${path}: ${id} reasoning ${level} exceeds cap ${cap}`);
  }
}

export function validatePolicy(policy) {
  const errors = [];
  const { check, fields, list, reasoning } = checks(errors);
  if (!fields(policy, 'policy', ['policyVersion', 'updated', 'routes', 'pools', 'tiers',
    'kinds', 'escalation', 'quota', 'tieBreak', 'review', 'cards', 'machines', 'repos'])) return { ok: false, errors };
  check(policy.policyVersion === 1, `unsupported policyVersion: ${policy.policyVersion}`);
  check(typeof policy.updated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(policy.updated)
    && !Number.isNaN(Date.parse(policy.updated))
    && new Date(policy.updated).toISOString().slice(0, 10) === policy.updated,
  'updated must be a valid YYYY-MM-DD date');
  for (const key of ['routes', 'pools', 'tiers', 'kinds', 'machines']) {
    check(object(policy[key]), `${key} must be an object`);
  }
  // Continue collecting useful errors even when a whole section is malformed.
  const routes = object(policy.routes) ? policy.routes : {};
  const pools = object(policy.pools) ? policy.pools : {};
  const kinds = object(policy.kinds) ? policy.kinds : {};
  const tiers = object(policy.tiers) ? policy.tiers : {};
  const machines = object(policy.machines) ? policy.machines : {};
  const routeIds = Object.keys(routes);
  const routeList = (value, path, min = 0) => {
    const ids = list(value, path, routeIds, min);
    // Give candidate errors a searchable, specific explanation.
    for (const id of ids) if (!has(routes, id)) errors.push(`${path}: unknown route id ${String(id)}`);
    return ids;
  };
  for (const id of ['muse', 'sonnet', 'opus', 'astra', 'luna', 'pi-local']) check(has(routes, id), `routes.${id} is required`);
  for (const id of ['muse', 'claude', 'codex', 'local']) check(has(pools, id), `pools.${id} is required`);
  for (const id of ['mac-studio', 'pc']) check(has(machines, id), `machines.${id} is required`);
  for (const [id, entry] of Object.entries(machines)) {
    if (fields(entry, `machines.${id}`, ['description'])) check(nonempty(entry.description), `machines.${id}.description is required`);
  }
  for (const [id, entry] of Object.entries(pools)) {
    const path = `pools.${id}`;
    if (!fields(entry, path, ['readable', 'free', 'windows'], ['requiredProvider'])) continue;
    check(typeof entry.readable === 'boolean', `${path}.readable must be boolean`);
    check(typeof entry.free === 'boolean', `${path}.free must be boolean`);
    list(entry.windows, `${path}.windows`, ['five-hour', 'weekly']);
    if (has(entry, 'requiredProvider')) check(nonempty(entry.requiredProvider), `${path}.requiredProvider must be a provider id`);
  }
  check(pools.claude?.requiredProvider === 'claude-code', 'pools.claude.requiredProvider must be claude-code');
  for (const [id, route] of Object.entries(routes)) {
    const path = `routes.${id}`;
    if (!fields(route, path, ['provider', 'model', 'machines', 'pool', 'vendor'],
      ['maxReasoning', 'runningByDefault', 'livenessCheck'])) continue;
    check(nonempty(route.provider), `${path}.provider is required`);
    check(nonempty(route.model), `${path}.model is required`);
    check(!String(route.model).includes('-contributor'), `${path}.model: -contributor models are forbidden`);
    list(route.machines, `${path}.machines`, Object.keys(machines), 1);
    check(has(pools, route.pool), `${path}.pool: unknown pool ${route.pool}`);
    check(['anthropic', 'openai', 'meta', 'local'].includes(route.vendor), `${path}.vendor is unsupported`);
    const requiredProvider = route.pool === 'claude' ? 'claude-code' : pools[route.pool]?.requiredProvider;
    check(!requiredProvider || route.provider === requiredProvider, `${path}: pool ${route.pool} requires provider ${requiredProvider}`);
    if (muse(id, route)) check(Array.isArray(route.machines) && route.machines.every(m => m === 'mac-studio'), `${path}: Muse is mac-studio only`);
    if (has(route, 'maxReasoning')) reasoning(route.maxReasoning, `${path}.maxReasoning`);
    if (sonnet(id, route)) check(route.maxReasoning === 'high', `${path}: Sonnet maxReasoning must be high`);
    if (has(route, 'runningByDefault')) check(typeof route.runningByDefault === 'boolean', `${path}.runningByDefault must be boolean`);
    if (route.runningByDefault === false || has(route, 'livenessCheck')) check(nonempty(route.livenessCheck), `${path}.livenessCheck is required`);
  }
  const selection = (entry, path, nullable = false) => {
    const candidates = routeList(entry.candidates, `${path}.candidates`, 1);
    const fallbacks = routeList(entry.fallbacks, `${path}.fallbacks`);
    check(!candidates.some(id => fallbacks.includes(id)), `${path}: candidates and fallbacks must not overlap`);
    reasoning(entry.reasoning, `${path}.reasoning`, nullable);
    if (has(entry, 'fallbackReasoning')) reasoning(entry.fallbackReasoning, `${path}.fallbackReasoning`);
    if (entry.reasoning === null && fallbacks.length) check(has(entry, 'fallbackReasoning'), `${path}.fallbackReasoning is required when reasoning is null`);
    checkRouteReasoning(candidates, entry.reasoning, routes, path, check);
    checkRouteReasoning(fallbacks, entry.fallbackReasoning ?? entry.reasoning, routes, path, check);
    return [...candidates, ...fallbacks];
  };
  for (const id of ['1', '2', '3']) check(has(tiers, id), `tiers.${id} is required`);
  for (const [id, entry] of Object.entries(tiers)) {
    check(['1', '2', '3'].includes(id), `tiers: unsupported tier ${id}`);
    if (fields(entry, `tiers.${id}`, ['candidates', 'fallbacks', 'reasoning'])) selection(entry, `tiers.${id}`);
  }
  for (const id of KIND_IDS) check(has(kinds, id), `kinds.${id} is required`);
  for (const [id, entry] of Object.entries(kinds)) {
    const path = `kinds.${id}`;
    check(KIND_IDS.includes(id), `unknown kind ${id}`);
    if (!fields(entry, path, ['tier', 'reasoning', 'description', 'candidates', 'fallbacks'],
      ['excludedRoutes', 'fallbackReasoning', 'tool', 'alternativeTool'])) continue;
    check([1, 2, 3, 'local', 'image'].includes(entry.tier), `${path}.tier is unsupported`);
    check(nonempty(entry.description), `${path}.description is required`);
    const ids = selection(entry, path, ['local', 'image'].includes(entry.tier));
    const excluded = has(entry, 'excludedRoutes') ? routeList(entry.excludedRoutes, `${path}.excludedRoutes`) : [];
    check(!ids.some(r => excluded.includes(r)), `${path}: excluded route appears in candidates or fallbacks`);
    if (id === 'skill-workflow') {
      check(excluded.includes('muse'), `${path}.excludedRoutes must include muse`);
      check(!ids.some(r => muse(r, routes[r])), `${path}: Muse cannot follow skills reliably`);
    }
    for (const key of ['tool', 'alternativeTool']) if (has(entry, key)) check(nonempty(entry[key]), `${path}.${key} must name a tool`);
  }
  const escalation = policy.escalation;
  if (fields(escalation, 'escalation', ['escalateAfterFailures', 'failuresScope', 'steps'])) {
    check(Number.isInteger(escalation.escalateAfterFailures) && escalation.escalateAfterFailures > 0, 'escalation.escalateAfterFailures must be a positive integer');
    check(escalation.failuresScope === 'current-tier', 'escalation.failuresScope must be current-tier');
    if (fields(escalation.steps, 'escalation.steps', ['1', '2'])) {
      for (const [from, step] of Object.entries(escalation.steps)) {
        const path = `escalation.steps.${from}`;
        if (!fields(step, path, ['tier', 'reasoning'])) continue;
        check(step.tier === Number(from) + 1 && step.tier <= 3, `${path}.tier must advance one tier`);
        reasoning(step.reasoning, `${path}.reasoning`);
        const target = tiers[step.tier];
        checkRouteReasoning([...(Array.isArray(target?.candidates) ? target.candidates : []),
          ...(Array.isArray(target?.fallbacks) ? target.fallbacks : [])], step.reasoning, routes, path, check);
      }
    }
  }
  const quota = policy.quota;
  if (fields(quota, 'quota', ['overridesBeatHardStops', 'thresholds', 'limitErrors', 'allLimited'])) {
    check(quota.overridesBeatHardStops === false, 'quota.overridesBeatHardStops must be false');
    check(Array.isArray(quota.thresholds), 'quota.thresholds must be an array');
    for (const [i, rule] of (Array.isArray(quota.thresholds) ? quota.thresholds : []).entries()) {
      const path = `quota.thresholds[${i}]`;
      const reserve = rule?.action === 'reserve-pool';
      if (!fields(rule, path, ['pool', 'window', 'usedPercentAbove', 'action',
        ...(reserve ? ['allowedTiers', 'allowMainThreads'] : ['tiers', 'route'])])) continue;
      check(has(pools, rule.pool), `${path}: unknown pool ${rule.pool}`);
      check(Array.isArray(pools[rule.pool]?.windows) && pools[rule.pool].windows.includes(rule.window), `${path}: unknown window ${rule.window} for pool ${rule.pool}`);
      check(typeof rule.usedPercentAbove === 'number' && rule.usedPercentAbove >= 0 && rule.usedPercentAbove <= 100, `${path}.usedPercentAbove must be between 0 and 100`);
      check(['prefer-route', 'reserve-pool'].includes(rule.action), `${path}.action is unsupported`);
      list(reserve ? rule.allowedTiers : rule.tiers, `${path}.${reserve ? 'allowedTiers' : 'tiers'}`, [1, 2, 3], 1);
      if (reserve) check(typeof rule.allowMainThreads === 'boolean', `${path}.allowMainThreads must be boolean`);
      else routeList([rule.route], `${path}.route`);
    }
    check(Array.isArray(quota.limitErrors), 'quota.limitErrors must be an array');
    for (const [i, rule] of (Array.isArray(quota.limitErrors) ? quota.limitErrors : []).entries()) {
      const path = `quota.limitErrors[${i}]`;
      if (!fields(rule, path, ['route', 'fallback', 'cooldownHours'])) continue;
      routeList([rule.route, rule.fallback], path);
      check(Number.isFinite(rule.cooldownHours) && rule.cooldownHours > 0, `${path}.cooldownHours must be positive`);
    }
    if (fields(quota.allLimited, 'quota.allLimited', ['route', 'kinds', 'otherwise'])) {
      routeList([quota.allLimited.route], 'quota.allLimited.route');
      check(routes[quota.allLimited.route]?.pool === 'local', 'quota.allLimited.route must use the local pool');
      list(quota.allLimited.kinds, 'quota.allLimited.kinds', KIND_IDS, 1);
      check(quota.allLimited.otherwise === 'stop-and-report', 'quota.allLimited.otherwise must be stop-and-report');
    }
  }
  const tie = policy.tieBreak;
  if (fields(tie, 'tieBreak', ['tier', 'order', 'pcCandidates', 'tieBreak', 'window', 'onTie', 'routes', 'label'])) {
    check(tie.tier === 2, 'tieBreak.tier must be 2');
    check(JSON.stringify(tie.order) === JSON.stringify(['repo-override', 'machine', 'weekly-headroom', 'alternate']), 'tieBreak.order must be repo-override, machine, weekly-headroom, alternate');
    routeList(tie.pcCandidates, 'tieBreak.pcCandidates', 1);
    routeList(tie.routes, 'tieBreak.routes', 2);
    check(tie.tieBreak === 'pace', 'tieBreak.tieBreak must be pace');
    check(tie.window === 'weekly', 'tieBreak.window must be weekly');
    check(tie.onTie === 'alternate', 'tieBreak.onTie must be alternate');
    check(tie.label === 'trial', 'tieBreak.label must be trial');
  }
  if (fields(policy.review, 'review', ['differentVendor', 'kinds'])) {
    check(policy.review.differentVendor === true, 'review.differentVendor must be true');
    list(policy.review.kinds, 'review.kinds', KIND_IDS, 1);
  }
  if (fields(policy.cards, 'cards', ['requireTrust', 'maxAgeDays'])) {
    check(policy.cards.requireTrust === 'CALIBRATED', 'cards.requireTrust must be CALIBRATED');
    // ⚠ JSON needs a literal; validate against the trust gate so it cannot drift silently.
    check(policy.cards.maxAgeDays === TRUST.STALE_DAYS, `cards.maxAgeDays must match TRUST.STALE_DAYS (${TRUST.STALE_DAYS})`);
  }
  check(object(policy.repos), 'repos must be an object keyed by owner/name');
  // ⚠ Reuse rule validation only after its route/kind dependencies are valid.
  if (errors.length === 0) {
    for (const [repo, entry] of Object.entries(policy.repos)) {
      check(parseRepoUrl(`https://github.com/${repo}`) === repo, `repos: invalid GitHub repo key ${repo}`);
      errors.push(...validateRules(entry, policy, false).errors.map(e => `repos.${repo}: ${e}`));
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateOverride(override, policy) {
  const validated = validatePolicy(policy);
  if (!validated.ok) return { ok: false, errors: validated.errors.map(e => `policy: ${e}`) };
  return validateRules(override, policy, true);
}

function validateRules(override, policy, versioned) {
  const errors = [];
  const { check, fields, list, reasoning } = checks(errors);
  if (!fields(override, 'override', versioned ? ['policyVersion', 'rules'] : ['rules'], ['machines'])) return { ok: false, errors };
  if (versioned) check(override.policyVersion === policy.policyVersion, `unsupported policyVersion: ${override.policyVersion}`);
  const machines = has(override, 'machines')
    ? list(override.machines, 'override.machines', Object.keys(policy.machines), 1)
    : Object.keys(policy.machines);
  check(Array.isArray(override.rules), 'override.rules must be an array');
  const seen = new Set();
  for (const [i, rule] of (Array.isArray(override.rules) ? override.rules : []).entries()) {
    const path = `override.rules[${i}]`;
    if (!fields(rule, path, ['kinds', 'route', 'source', 'why'], ['reasoning'])) continue;
    const kinds = list(rule.kinds, `${path}.kinds`, Object.keys(policy.kinds), 1);
    for (const kind of kinds) {
      check(has(policy.kinds, kind), `${path}: unknown kind ${String(kind)}`);
      check(!seen.has(kind), `${path}: duplicate rule for kind ${String(kind)}`);
      seen.add(kind);
    }
    check(has(policy.routes, rule.route), `${path}: unknown route id ${rule.route}`);
    check(nonempty(rule.source), `${path}.source is required`);
    check(nonempty(rule.why), `${path}.why is required`);
    if (has(rule, 'reasoning')) reasoning(rule.reasoning, `${path}.reasoning`);
    const route = policy.routes[rule.route];
    if (!has(policy.routes, rule.route)) continue;
    check(route.machines.some(m => machines.includes(m)), `${path}: route ${rule.route} is unavailable on repo machines ${machines.join(', ')}${muse(rule.route, route) ? ' (Muse is mac-studio only)' : ''}`);
    if (has(rule, 'reasoning')) checkRouteReasoning([rule.route], rule.reasoning, policy.routes, path, check);
    for (const kind of kinds) {
      if (!has(policy.kinds, kind)) continue;
      check(!policy.kinds[kind].excludedRoutes?.includes(rule.route)
        && !(kind === 'skill-workflow' && muse(rule.route, route)), `${path}: ${rule.route} is excluded for ${kind}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function assertValid(result, label) {
  if (!result.ok) throw new TypeError(`Invalid ${label}:\n${result.errors.join('\n')}`);
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Synchronous JSON loaders; source paths in rules are never opened. */
export function loadPolicy(path = new URL('../policy/policy.json', import.meta.url)) {
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  assertValid(validatePolicy(policy), 'policy');
  return freeze(policy);
}
export function loadOverride(repoDir) {
  let contents;
  try { contents = readFileSync(join(repoDir, '.model-routing.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const override = JSON.parse(contents);
  assertValid(validateOverride(override, loadPolicy()), 'override');
  return freeze(override);
}

/** Pure GitHub URL parser. Reject other hosts and ambiguous paths. */
export function parseRepoUrl(remote) {
  if (typeof remote !== 'string') return null;
  const value = remote.trim();
  let path;
  const scp = /^(?:[a-z\d._-]+@)?github\.com:([^\s?#]+)$/i.exec(value);
  if (scp) path = scp[1];
  else {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com'
      || url.search || url.hash) return null;
    path = url.pathname.slice(1);
  }
  const match = /^([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+?)(?:\.git)?\/?$/i.exec(path);
  if (!match || ['.', '..'].includes(match[2])) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

/** Local Git metadata only. Inject execFile for offline tests; never invokes a shell. */
export function repoKey(repoDir, { execFile = execFileSync } = {}) {
  let remote;
  try {
    remote = execFile('git', ['-C', repoDir, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // ⚠ Missing origin/not a Git repo means no central rule; broken Git must stay visible.
    if (error.status === 2 || (error.status === 128 && /not a git repository/i.test(String(error.stderr)))) return null;
    throw error;
  }
  return parseRepoUrl(remote);
}

export function kindsForClassifier(policy) {
  assertValid(validatePolicy(policy), 'policy');
  return Object.entries(policy.kinds).map(([id, { description }]) => ({ id, description }));
}

/** Expand policy order only. PR 3 applies quota, liveness, vendor checks and card trust. */
export function resolveCandidates(policy, kind, { repo = null, override = null, machine, failures = 0 } = {}) {
  assertValid(validatePolicy(policy), 'policy');
  if (!has(policy.kinds, kind)) throw new TypeError(`Unknown kind: ${kind}`);
  if (override !== null) assertValid(validateOverride(override, policy), 'override');
  if (machine !== undefined && !has(policy.machines, machine)) throw new TypeError(`Unknown machine: ${machine}`);
  if (!Number.isInteger(failures) || failures < 0) throw new TypeError('failures must be a nonnegative integer');
  if (repo !== null && typeof repo !== 'string') throw new TypeError('repo must be an owner/name string or null');
  const repoRules = has(policy.repos, repo) ? policy.repos[repo] : null;
  const entry = policy.kinds[kind];
  const step = failures >= policy.escalation.escalateAfterFailures
    ? policy.escalation.steps[entry.tier] : undefined;
  const selection = step ? policy.tiers[step.tier] : entry;
  const level = step ? step.reasoning : entry.reasoning;
  const reason = step ? `${failures} failures: tier ${entry.tier} -> ${step.tier}` : `policy kind ${kind}, tier ${entry.tier}`;
  const proposed = [
    ...selection.candidates.map(route => ({ route, reasoning: level, reason })),
    ...selection.fallbacks.map(route => ({ route, reasoning: selection.fallbackReasoning ?? level, reason: `${reason}; fallback` })),
  ];
  // ⚠ Repo instructions outrank tiers, including escalation. Hard constraints still apply.
  for (const [rules, origin] of [[repoRules, `policy repo ${repo}`], [override, 'repo override']]) {
    const rule = rules?.rules.find(r => r.kinds.includes(kind));
    if (rule) proposed.unshift({ route: rule.route, reasoning: rule.reasoning ?? level,
      reason: `${origin} ${rule.source}: ${rule.why}` });
  }
  const allowed = override?.machines ?? repoRules?.machines ?? Object.keys(policy.machines);
  const seen = new Set();
  const result = [];
  for (const candidate of proposed) {
    const id = candidate.route;
    const route = policy.routes[id];
    if (seen.has(id) || entry.excludedRoutes?.includes(id)
      || (kind === 'skill-workflow' && muse(id, route))) continue;
    const machines = route.machines.filter(m => allowed.includes(m) && (machine === undefined || machine === m));
    if (!machines.length) continue;
    seen.add(id);
    const cap = capFor(id, route);
    const capped = cap && LEVELS.indexOf(candidate.reasoning) > LEVELS.indexOf(cap);
    result.push({ route: id, provider: route.provider, model: route.model,
      reasoning: capped ? cap : candidate.reasoning, machines, pool: route.pool, vendor: route.vendor,
      reason: candidate.reason + (capped ? `; reasoning capped at ${cap}` : '') });
  }
  return result;
}
