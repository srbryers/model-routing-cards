/** Policy data and deterministic candidate expansion. No probes, quota reads or credentials. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateLocalConfig } from './local-config.mjs';
import { TRUST } from './card.mjs';

const VENDORS = ['anthropic', 'openai', 'meta', 'local', 'google', 'moonshot', 'zhipu', 'deepseek', 'minimax', 'alibaba'];
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const KIND_IDS = [
  'bounded-build', 'quick-edit', 'write-tests', 'docs', 'scouting', 'first-pass-review',
  'simple-bug-fix', 'multi-step-coding', 'migration', 'hard-bug-fix', 'ci-terminal',
  'routine-review', 'skill-workflow', '3d-work', 'ui-visual', 'ios', 'architecture',
  'high-risk-review', 'data-contract', 'bulk-text', 'image-generation',
  'user-facing-copy', 'visual-implementation',
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

export const machineIds = policy => Object.keys(policy.machines).filter(id => id !== 'default');

function capFor(id, route) {
  // ⚠ A renamed Sonnet route must not bypass its token-use cap.
  return sonnet(id, route) ? 'xhigh' : route?.maxReasoning;
}

function checkRouteReasoning(ids, level, routes, path, check) {
  for (const id of ids) {
    if (!has(routes, id) || level === null || routes[id]?.type === 'external') continue;
    const cap = capFor(id, routes[id]);
    check(!cap || LEVELS.indexOf(level) <= LEVELS.indexOf(cap),
      `${path}: ${id} reasoning ${level} exceeds cap ${cap}`);
  }
}

export function validatePolicy(policy) {
  const errors = [];
  const { check, fields, list, reasoning } = checks(errors);
  if (!fields(policy, 'policy', ['policyVersion', 'updated', 'routes', 'pools', 'tiers',
    'kinds', 'escalation', 'quota', 'tieBreak', 'review', 'cards', 'machines', 'repos', 'classifier', 'fieldEvidence'])) return { ok: false, errors };
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
  const machineNames = Object.keys(machines).filter(id => id !== 'default');
  check(machineNames.includes(machines.default), 'machines.default must name a configured machine');
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
    if (id === 'default') continue;
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
    for (const [field, value] of [['id', id], ['model', route?.model], ['provider', route?.provider]]) {
      check(!/contributor/i.test(value ?? ''), `${path}.${field}: contributor routes are forbidden`);
    }
    if (route?.vendor === 'anthropic' || /^claude/i.test(route?.model ?? '')
      || route?.provider === 'claude-code' || route?.pool === 'claude') {
      check(route?.provider === 'claude-code' && route?.pool === 'claude'
        && route?.vendor === 'anthropic' && /^claude/i.test(route?.model ?? ''),
      `${path}: Claude requires a claude model, provider claude-code, pool claude and vendor anthropic`);
    }
    if (route?.provider === 'codex' || route?.pool === 'codex') {
      check(route?.provider === 'codex' && route?.pool === 'codex' && route?.vendor === 'openai',
        `${path}: codex provider and pool must agree with vendor openai`);
    }
    if (route?.provider === 'acp-muse' || route?.pool === 'muse') {
      check(route?.provider === 'acp-muse' && route?.pool === 'muse', `${path}: acp-muse provider and muse pool must agree`);
    }
    if (route?.type === 'external') {
      if (!fields(route, path, ['type', 'instruction', 'requiresSpendApproval', 'vendor', 'pool'])) continue;
      check(nonempty(route.instruction), `${path}.instruction is required`);
      check(typeof route.requiresSpendApproval === 'boolean', `${path}.requiresSpendApproval must be boolean`);
      check(VENDORS.includes(route.vendor), `${path}.vendor is unsupported`);
      check(route.pool === 'metered' && has(pools, route.pool), `${path}: external routes require the metered pool`);
      continue;
    }
    if (!fields(route, path, ['provider', 'model', 'machines', 'pool', 'vendor'],
      ['type', 'maxReasoning', 'runningByDefault', 'livenessCheck', 'cardModels', 'modelFrom', 'costPer1M', 'disabled', 'requiresSpendApproval', 'note'])) continue;
    check(!has(route, 'type') || route.type === 'bb', `${path}.type must be bb or external`);
    check(nonempty(route.provider), `${path}.provider is required`);
    if (has(route, 'modelFrom')) {
      check(route.modelFrom === 'local', `${path}.modelFrom must be local`);
      check(route.model === null, `${path}.model must be null when modelFrom is local`);
    } else check(nonempty(route.model), `${path}.model is required`);
    list(route.machines, `${path}.machines`, machineNames, 1);
    check(has(pools, route.pool), `${path}.pool: unknown pool ${route.pool}`);
    check(VENDORS.includes(route.vendor), `${path}.vendor is unsupported`);
    const requiredProvider = route.pool === 'claude' ? 'claude-code' : pools[route.pool]?.requiredProvider;
    check(!requiredProvider || route.provider === requiredProvider, `${path}: pool ${route.pool} requires provider ${requiredProvider}`);
    if (muse(id, route)) check(Array.isArray(route.machines) && route.machines.every(m => m === 'mac-studio'), `${path}: Muse is mac-studio only`);
    if (has(route, 'disabled')) check(nonempty(route.disabled), `${path}.disabled must be a nonempty string`);
    if (has(route, 'note')) check(nonempty(route.note), `${path}.note must be a nonempty string`);
    if (has(route, 'requiresSpendApproval')) check(typeof route.requiresSpendApproval === 'boolean', `${path}.requiresSpendApproval must be boolean`);
    if (route.pool === 'metered') {
      check(route.requiresSpendApproval === true, `${path}: metered workers require spend approval`);
      check(has(route, 'costPer1M'), `${path}.costPer1M is required for metered workers`);
    }
    if (has(route, 'costPer1M') && fields(route.costPer1M, `${path}.costPer1M`, ['in', 'out'])) {
      for (const direction of ['in', 'out']) {
        const cost = route.costPer1M[direction];
        check(cost === null || (Number.isFinite(cost) && cost >= 0), `${path}.costPer1M.${direction} must be a nonnegative number or null`);
      }
    }
    if (has(route, 'maxReasoning')) reasoning(route.maxReasoning, `${path}.maxReasoning`);
    if (sonnet(id, route)) check(route.maxReasoning === 'xhigh', `${path}: Sonnet maxReasoning must be xhigh`);
    if (has(route, 'runningByDefault')) check(typeof route.runningByDefault === 'boolean', `${path}.runningByDefault must be boolean`);
    if (route.runningByDefault === false || has(route, 'livenessCheck')) check(nonempty(route.livenessCheck), `${path}.livenessCheck is required`);
  }
  const aliases = new Set();
  for (const [id, route] of Object.entries(routes)) {
    if (!has(route, 'cardModels')) continue;
    check(Array.isArray(route.cardModels), `routes.${id}.cardModels must be an array`);
    for (const alias of Array.isArray(route.cardModels) ? route.cardModels : []) {
      check(nonempty(alias) && !aliases.has(alias), `routes.${id}.cardModels must contain unique nonempty aliases`);
      aliases.add(alias);
    }
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
    if (fields(entry, `tiers.${id}`, ['candidates', 'fallbacks', 'reasoning'])) {
      for (const route of selection(entry, `tiers.${id}`)) {
        check(routes[route]?.type !== 'external', `tiers.${id}: external route ${route} is not allowed in a tier`);
      }
    }
  }
  for (const id of KIND_IDS) check(has(kinds, id), `kinds.${id} is required`);
  for (const [id, entry] of Object.entries(kinds)) {
    const path = `kinds.${id}`;
    check(KIND_IDS.includes(id), `unknown kind ${id}`);
    if (!fields(entry, path, ['tier', 'reasoning', 'description', 'candidates', 'fallbacks'],
      ['excludedRoutes', 'fallbackReasoning', 'tool', 'alternativeTool', 'crossTier', 'crossTierReason'])) continue;
    check([1, 2, 3, 'local', 'image'].includes(entry.tier), `${path}.tier is unsupported`);
    check(nonempty(entry.description), `${path}.description is required`);
    const ids = selection(entry, path, ['local', 'image'].includes(entry.tier));
    if (has(entry, 'crossTier')) check(typeof entry.crossTier === 'boolean', `${path}.crossTier must be boolean`);
    if (entry.crossTier === true) check(nonempty(entry.crossTierReason), `${path}.crossTierReason is required`);
    else {
      const tier = tiers[entry.tier];
      const allowed = [...(Array.isArray(tier?.candidates) ? tier.candidates : []),
        ...(Array.isArray(tier?.fallbacks) ? tier.fallbacks : [])];
      check(ids.every(route => allowed.includes(route)), `${path}: routes must belong to tier ${entry.tier}; otherwise declare crossTier with a reason`);
      check(!has(entry, 'crossTierReason'), `${path}.crossTierReason requires crossTier: true`);
    }
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
    check(escalation.failuresScope === 'task', 'escalation.failuresScope must be task');
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
  if (fields(quota, 'quota', ['overridesBeatHardStops', 'thresholds', 'limitErrors', 'meteredFallback'])) {
    if (fields(quota.meteredFallback, 'quota.meteredFallback', ['1', '2', '3'])) {
      for (const [tier, ids] of Object.entries(quota.meteredFallback)) {
        for (const id of routeList(ids, `quota.meteredFallback.${tier}`)) {
          check(routes[id]?.pool === 'metered' && routes[id]?.type === 'bb', `quota.meteredFallback.${tier}: ${id} must be a metered worker`);
        }
      }
      check(Array.isArray(quota.meteredFallback['3']) && quota.meteredFallback['3'].length === 0, 'quota.meteredFallback.3 must be empty');
    }
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
  }
  const tie = policy.tieBreak;
  if (fields(tie, 'tieBreak', ['tier', 'order', 'pcCandidates', 'tieBreak', 'window', 'onTie', 'routes', 'label', 'marginPoints']))
 {
    check(Number.isFinite(tie.marginPoints) && tie.marginPoints >= 0 && tie.marginPoints <= 100, 'tieBreak.marginPoints must be between 0 and 100');
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
  if (fields(policy.cards, 'cards', ['requireTrust', 'maxAgeDays', 'byKind'])) {
    check(object(policy.cards.byKind), 'cards.byKind must be an object');
    for (const [kind, file] of Object.entries(object(policy.cards.byKind) ? policy.cards.byKind : {})) {
      check(has(kinds, kind), `cards.byKind: unknown kind ${kind}`);
      check(typeof file === 'string' && /^[a-z0-9-]+\.card\.json$/.test(file), `cards.byKind.${kind} must name a <task-id>.card.json basename`);
    }
    check(policy.cards.requireTrust === 'CALIBRATED', 'cards.requireTrust must be CALIBRATED');
    // ⚠ JSON needs a literal; validate against the trust gate so it cannot drift silently.
    check(policy.cards.maxAgeDays === TRUST.STALE_DAYS, `cards.maxAgeDays must match TRUST.STALE_DAYS (${TRUST.STALE_DAYS})`);
  }
  if (fields(policy.fieldEvidence, 'fieldEvidence', ['minOutcomesPerRoute', 'minRoutes'])) {
    for (const [key, minimum] of [['minOutcomesPerRoute', 1], ['minRoutes', 2]]) {
      check(Number.isSafeInteger(policy.fieldEvidence[key]) && policy.fieldEvidence[key] >= minimum,
        `fieldEvidence.${key} must be an integer at least ${minimum}`);
    }
  }
  if (fields(policy.classifier, 'classifier', ['minProbability', 'minMargin'])) {
    for (const [key, value] of Object.entries(policy.classifier)) {
      check(Number.isFinite(value) && value >= 0 && value <= 1, `classifier.${key} must be between 0 and 1`);
    }
  }
  check(object(policy.repos), 'repos must be an object keyed by owner/name');
  // ⚠ Reuse rule validation only after its route/kind dependencies are valid.
  if (errors.length === 0) {
    for (const [repo, entry] of Object.entries(policy.repos)) {
      check(normalizeRepo(repo) === repo, `repos: invalid GitHub repo key ${repo}`);
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
    ? list(override.machines, 'override.machines', machineIds(policy), 1)
    : machineIds(policy);
  check(Array.isArray(override.rules), 'override.rules must be an array');
  const seen = new Set();
  for (const [i, rule] of (Array.isArray(override.rules) ? override.rules : []).entries()) {
    const path = `override.rules[${i}]`;
    if (!fields(rule, path, ['kinds', 'source', 'why'], ['route', 'reasoning', 'excludeRoutes', 'note'])) continue;
    const kinds = list(rule.kinds, `${path}.kinds`, [...Object.keys(policy.kinds), '*'], 1);
    check(!kinds.includes('*') || kinds.length === 1, `${path}: wildcard * must be used alone`);
    for (const kind of kinds) {
      check(kind === '*' || has(policy.kinds, kind), `${path}: unknown kind ${String(kind)}`);
      check(!seen.has(kind), `${path}: duplicate rule for kind ${String(kind)}`);
      seen.add(kind);
    }
    if (has(rule, 'route')) {
      check(typeof rule.route === 'string', `${path}.route must be a string`);
      check(has(policy.routes, rule.route), `${path}: unknown route id ${rule.route}`);
    }
    const excludes = has(rule, 'excludeRoutes') ? list(rule.excludeRoutes, `${path}.excludeRoutes`, Object.keys(policy.routes)) : [];
    for (const route of excludes) check(typeof route === 'string', `${path}.excludeRoutes entries must be strings`);
    if (has(rule, 'note')) check(nonempty(rule.note), `${path}.note must be a nonempty string`);
    check(has(rule, 'route') || excludes.length > 0 || nonempty(rule.note), `${path}: supply route, excludeRoutes or note`);
    check(nonempty(rule.source), `${path}.source is required`);
    check(nonempty(rule.why), `${path}.why is required`);
    if (has(rule, 'reasoning')) {
      reasoning(rule.reasoning, `${path}.reasoning`);
      check(has(rule, 'route'), `${path}: reasoning requires a route`);
    }
    const route = policy.routes[rule.route];
    if (!has(policy.routes, rule.route)) continue;
    if (route.type === 'external') check(!has(rule, 'reasoning'), `${path}: external routes do not accept reasoning`);
    else check(route.machines.some(m => machines.includes(m)), `${path}: route ${rule.route} is unavailable on repo machines ${machines.join(', ')}${muse(rule.route, route) ? ' (Muse is mac-studio only)' : ''}`);
    if (has(rule, 'reasoning')) checkRouteReasoning([rule.route], rule.reasoning, policy.routes, path, check);
    for (const kind of kinds.includes('*') ? Object.keys(policy.kinds) : kinds) {
      if (!has(policy.kinds, kind)) continue;
      check(!policy.kinds[kind].excludedRoutes?.includes(rule.route)
        && !(kind === 'skill-workflow' && muse(rule.route, route)), `${path}: ${rule.route} is excluded for ${kind}`);
    }
  }
  if (errors.length === 0) {
    for (const [kind, entry] of Object.entries(policy.kinds)) {
      const matching = override.rules.filter(r => r.kinds.includes(kind) || r.kinds.includes('*'));
      const excluded = new Set(matching.flatMap(r => r.excludeRoutes ?? []));
      const preferred = matching.find(r => r.route && r.kinds.includes(kind)) ?? matching.find(r => r.route);
      const choices = [...entry.candidates, ...entry.fallbacks, ...(preferred ? [preferred.route] : [])];
      check(!choices.every(route => excluded.has(route)), `override: exclusions remove every route for ${kind}`);
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

function parseUniqueJson(text) {
  const value = JSON.parse(text);
  // ⚠ JSON.parse accepts duplicate keys. Scan valid JSON before trusting its result,
  // comparing decoded keys so escaped spellings cannot hide a duplicate.
  const stack = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\],]/gs;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === '{') stack.push({ keys: new Set(), key: true });
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { if (stack.at(-1)) stack.at(-1).key = true; }
    else if (stack.at(-1)?.key) {
      const frame = stack.at(-1);
      const key = JSON.parse(token);
      if (frame.keys.has(key)) throw new SyntaxError(`Duplicate JSON key ${JSON.stringify(key)} at offset ${match.index}`);
      frame.keys.add(key);
      frame.key = false;
    }
  }
  return value;
}

/** Synchronous JSON loaders; source paths in rules are never opened. */
export function loadPolicy(path = new URL('../policy/policy.json', import.meta.url)) {
  const policy = parseUniqueJson(readFileSync(path, 'utf8'));
  assertValid(validatePolicy(policy), 'policy');
  return freeze(policy);
}
export function loadOverride(repoDir) {
  let contents;
  try { contents = readFileSync(join(repoDir, '.model-routing.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const override = parseUniqueJson(contents);
  assertValid(validateOverride(override, loadPolicy()), 'override');
  return freeze(override);
}

function normalizeRepo(repo) {
  if (typeof repo !== 'string') return null;
  const key = repo.trim().toLowerCase().replace(/\.git$/, '');
  const match = /^([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+)$/.exec(key);
  return match && !['.', '..'].includes(match[2]) ? key : null;
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
  return normalizeRepo(path.replace(/\/$/, ''));
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
  return parseRepoUrl(Buffer.isBuffer(remote) ? remote.toString('utf8') : remote);
}

export function kindsForClassifier(policy) {
  assertValid(validatePolicy(policy), 'policy');
  return Object.entries(policy.kinds).map(([id, { description }]) => ({ id, description }));
}

/** Expand policy order only. PR 3 applies quota, liveness, vendor checks and card trust. */
export function resolveCandidates(policy, kind, { repo = null, override = null, machine, failures = 0, reviewFallbacks = false, meteredFallbacks = false, localConfig = null } = {}) {
  assertValid(validatePolicy(policy), 'policy');
  if (localConfig !== null) assertValid(validateLocalConfig(localConfig, policy), 'local config');
  if (!has(policy.kinds, kind)) throw new TypeError(`Unknown kind: ${kind}`);
  if (override !== null) assertValid(validateOverride(override, policy), 'override');
  if (machine !== undefined && !machineIds(policy).includes(machine)) throw new TypeError(`Unknown machine: ${machine}`);
  if (!Number.isInteger(failures) || failures < 0) throw new TypeError('failures must be a nonnegative integer');
  if (repo !== null) {
    repo = normalizeRepo(repo);
    if (repo === null) throw new TypeError('repo must be a valid owner/name string or null');
  }
  const repoRules = has(policy.repos, repo) ? policy.repos[repo] : null;
  const entry = policy.kinds[kind];
  const thresholdReached = failures >= policy.escalation.escalateAfterFailures;
  let step;
  let currentTier = entry.tier;
  // ⚠ Failures count across the whole task; a large count must not restart tier 2.
  for (let remaining = Math.floor(failures / policy.escalation.escalateAfterFailures); remaining > 0; remaining--) {
    const next = policy.escalation.steps[currentTier];
    if (!next) break;
    step = next;
    currentTier = next.tier;
  }
  const selection = step ? policy.tiers[step.tier] : entry;
  const tier = step ? step.tier : entry.tier;
  const level = step ? step.reasoning : entry.reasoning;
  const reason = step ? `${failures} failures: tier ${entry.tier} -> ${tier}` : `policy kind ${kind}, tier ${entry.tier}`;
  const proposed = [
    ...selection.candidates.map(route => ({ route, reasoning: level, reason, fallback: false })),
    ...selection.fallbacks.map(route => ({ route, reasoning: selection.fallbackReasoning ?? level,
      reason: `${reason}; fallback`, fallback: true })),
  ].map(candidate => ({ ...candidate, source: step ? 'tier' : 'kind', escalated: !!step }));
  // ⚠ Independent review may need the nearest tier; exclusions still pass through this resolver.
  if (reviewFallbacks) {
    const targetTier = step?.tier ?? entry.tier;
    const nearest = Object.entries(policy.tiers).sort(([a], [b]) =>
      Math.abs(Number(a) - targetTier) - Math.abs(Number(b) - targetTier) || Number(b) - Number(a));
    for (const [tier, defaults] of nearest) {
      for (const route of [...defaults.candidates, ...defaults.fallbacks]) {
        proposed.push({ route, reasoning: defaults.reasoning, source: 'tier', fallback: true, escalated: thresholdReached, reason: `nearest different-vendor review route, tier ${tier}` });
      }
    }
  }
  // ⚠ Pick enables this expansion only after subscriptions were exhausted by limits.
  if (meteredFallbacks) {
    for (const route of policy.quota.meteredFallback[tier] ?? []) {
      proposed.push({ route, reasoning: level, source: 'tier', fallback: true, escalated: !!step,
        reason: 'metered fallback order is unmeasured; no card backs it' });
    }
  }
  const excluded = new Set(entry.excludedRoutes ?? []);
  const notes = [];
  const blocked = [];
  // ⚠ Keep repo preferences visible after failure, but mark them escalated and expose
  // the next-tier candidates so pick can stop retrying the same failing route.
  for (const [rules, source, origin] of [[repoRules, 'repo', `policy repo ${repo}`], [override, 'file', 'repo override']]) {
    const matching = rules?.rules.filter(r => r.kinds.includes(kind) || r.kinds.includes('*')) ?? [];
    for (const match of matching) {
      for (const id of match.excludeRoutes ?? []) excluded.add(id);
      if (match.note) notes.push(match.note);
    }
    const rule = matching.find(r => r.route && r.kinds.includes(kind)) ?? matching.find(r => r.route);
    for (const other of matching) {
      if (other.route && other !== rule) blocked.push({ route: other.route, why: `${source} wildcard route replaced by specific rule for ${kind}` });
    }
    if (rule) {
      for (const candidate of proposed) candidate.fallback = true;
      proposed.unshift({ route: rule.route, reasoning: rule.reasoning ?? level, source,
        escalated: thresholdReached, fallback: false, reason: `${origin} ${rule.source}: ${rule.why}` });
    }
  }
  const allowed = override?.machines ?? repoRules?.machines ?? machineIds(policy);
  const note = [...new Set(notes)].join(' ');
  const seen = new Map();
  const candidates = [];
  for (const candidate of proposed) {
    const id = candidate.route;
    const route = policy.routes[id];
    if (excluded.has(id) || (kind === 'skill-workflow' && muse(id, route))) {
      blocked.push({ route: id, why: `excluded for ${kind} by policy or matching repo/file rule` });
      continue;
    }
    if (route.disabled) {
      blocked.push({ route: id, why: route.disabled });
      continue;
    }
    const external = route.type === 'external';
    const model = route.modelFrom === 'local' ? localConfig?.routes[id]?.model : route.model;
    if (!external && !model) {
      blocked.push({ route: id, why: `${id} model not configured in local.json` });
      continue;
    }
    const machines = external ? [] : route.machines.filter(m => allowed.includes(m) && (machine === undefined || machine === m));
    if ((machine !== undefined && !allowed.includes(machine)) || (!external && !machines.length)) {
      blocked.push({ route: id, why: `machine limit: requested ${machine ?? 'any'}, repo allows ${allowed.join(', ')}, route allows ${external ? 'external instruction' : route.machines.join(', ')}` });
      continue;
    }
    if (seen.has(id)) {
      blocked.push({ route: id, why: `${candidate.source} candidate superseded by ${seen.get(id)} candidate for the same route` });
      continue;
    }
    seen.set(id, candidate.source);
    const cap = capFor(id, route);
    const capped = !external && cap && LEVELS.indexOf(candidate.reasoning) > LEVELS.indexOf(cap);
    candidates.push({ route: id, type: external ? 'external' : 'bb',
      provider: external ? null : route.provider, model: external ? null : model,
      reasoning: external ? null : capped ? cap : candidate.reasoning, machines,
      pool: route.pool, vendor: route.vendor, tier, source: candidate.source,
      fallback: candidate.fallback, escalated: candidate.escalated,
      reason: candidate.reason + (capped ? `; reasoning capped at ${cap}` : ''),
      ...(external ? { instruction: route.instruction, requiresSpendApproval: route.requiresSpendApproval } : {}),
      ...(route.costPer1M ? { costPer1M: route.costPer1M, requiresSpendApproval: route.requiresSpendApproval } : {}),
      ...(note || route.note ? { note: [note, route.note].filter(Boolean).join(' ') } : {}) });
  }
  return { candidates, blocked };
}
