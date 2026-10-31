/** Flora setup step 3. Pure policy checks; this module never calls a provider. */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertLiveIdentity } from './identity.mjs';
import { isStale } from './card.mjs';

export const profile = JSON.parse(readFileSync(new URL('../policy/flora/profile.json', import.meta.url), 'utf8'));
export const rolePolicy = JSON.parse(readFileSync(new URL('../policy/flora/role-policy.json', import.meta.url), 'utf8'));
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = (condition, message) => { if (!condition) throw new TypeError(message); };
const QUALITY_SAMPLE_FLOOR = 3;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
export const canonicalRole = role => profile.aliases[role] ?? role;
export const isFloraRole = role => Object.hasOwn(profile.roles, canonicalRole(role));
export function loadFloraCards() {
  const dir = new URL('../policy/flora/cards/', import.meta.url);
  return readdirSync(dir).filter(name => name.endsWith('.card.json')).map(name => JSON.parse(readFileSync(new URL(name, dir), 'utf8')));
}
export function assertRoleRoute(role, route) {
  const rule = rolePolicy.roles[canonicalRole(role)];
  need(rule, 'Unknown Flora role');
  assertLiveIdentity(route);
  need(rule.classes.includes(route.modelClass) && rule.vendors.includes(route.vendor), 'Route class or vendor prohibited for role');
  need(route.vendor !== 'anthropic' || route.provider === 'claude-code', 'Claude requires Claude Code; OpenRouter and Pi are forbidden');
  need(route.vendor !== 'google' && route.provider !== 'pi', 'Gemini and Pi require Sebastian direction and a new scoped profile');
  need(rule.providers.includes(route.provider), 'Provider prohibited for role');
  return route;
}
export function validateFloraCards(cards = loadFloraCards()) {
  const livePolicy = JSON.parse(readFileSync(new URL('../policy/policy.json', import.meta.url), 'utf8'));
  assertLiveIdentity(livePolicy);
  for (const [id, route] of Object.entries(profile.routes)) {
    if (id === 'jev') continue;
    // Sebastian's 2026-10-31 platform seat is separate from generic Muse Spark dispatch.
    if (id === 'muse-wonder') {
      const seat = { model: 'muse-wonder', cardIdentity: 'meta/muse-wonder', provider: 'muse', vendor: 'meta', pool: 'muse', modelClass: 'orchestrator' };
      need(Object.entries(seat).every(([field, value]) => route[field] === value), 'Muse Wonder platform seat identity mismatch');
      continue;
    }
    const live = livePolicy.routes[id];
    need(live && ['model', 'provider', 'vendor', 'pool'].every(field => live[field] === route[field]) && live.cardModels.includes(route.cardIdentity), 'Live policy and Flora route identity mismatch');
  }
  need(cards.length === Object.keys(profile.roles).length, 'Expected eleven Flora cards');
  need(new Set(cards.map(card => card.task)).size === cards.length, 'Duplicate Flora card');
  for (const card of cards) {
    assertLiveIdentity(card);
    const config = profile.roles[card.task];
    need(config, 'Unknown Flora card');
    need(card.version === 1 && card.trust === 'UNCALIBRATED' && card.recommend === null && card.models.length === 0, 'Static cards must remain UNCALIBRATED without measurements');
    need(card.policy_hash === hash(rolePolicy) && card.profile_hash === hash(profile), 'Card policy or profile hash mismatch');
    need(card.expires_days === 30 && /^\d{4}-\d{2}-\d{2}$/.test(card.generated), 'Card date or expiry mismatch');
    need(JSON.stringify(card.modelConfig) === JSON.stringify(config), 'Card modelConfig differs from approved profile');
    for (const id of [config.selectedRoute, ...config.fallbacks]) {
      assertRoleRoute(card.task, profile.routes[id]);
    }
    if (config.selectedRoute === 'jev') need(config.semanticUse === 'blocked' && config.familyIdentity === 'unconfirmed', 'Jev semantic use must stay blocked');
  }
  return { ok: true, cards: cards.length, livePolicyHash: hash(livePolicy), policyHash: hash(rolePolicy), profileHash: hash(profile), cardHash: hash(cards) };
}

/** Every reported measurement includes its source; null means unavailable. */
export function validatePoolState(poolState) {
  need(poolState?.version === 1 && Number.isFinite(Date.parse(poolState.capturedAt)), 'Pool state requires version and capturedAt');
  for (const [pool, fields] of Object.entries({ claude: ['sessionHeadroom', 'weeklyHeadroom'], codex: ['credits', 'planLimits'] })) {
    for (const field of fields) {
      const measure = poolState[pool]?.[field];
      need(measure && Object.hasOwn(measure, 'value') && nonempty(measure.source) && nonempty(measure.unit), `Pool state requires ${pool}.${field} value, source and unit`);
      need(measure.value === null || (Number.isFinite(measure.value) && measure.value >= 0), 'Pool measurements must be nonnegative or null');
    }
  }
  need(poolState.costUsd === null && poolState.costSource === 'unknown', 'Subscription costs must remain unknown');
  return poolState;
}
export function validateRoutingDecision(entry) {
  need(entry?.version === 1 && nonempty(entry.id) && nonempty(entry.jobId) && Number.isSafeInteger(entry.round) && entry.round >= 1, 'Decision requires identity, job and round');
  need(['dispatch', 'round_boundary'].includes(entry.boundary), 'Route changes only at dispatch or round boundaries');
  need(!entry.previousRoute || entry.boundary === 'round_boundary', 'A route change requires a round boundary');
  need(nonempty(entry.reason) && entry.selection_basis === 'approved_profile' && entry.basis === 'policy', 'Decision requires approved profile basis and reason');
  need(entry.policyHash === hash(rolePolicy) && entry.profileHash === hash(profile), 'Decision policy or profile hash mismatch');
  validatePoolState(entry.poolState);
  need(entry.poolState.capturedAt === entry.at, 'Decision must carry its boundary pool snapshot');
  const role = canonicalRole(entry.kind);
  const config = profile.roles[role];
  need(config && [config.selectedRoute, ...config.fallbacks].includes(entry.route), 'Decision route outside role allowlist');
  assertRoleRoute(role, profile.routes[entry.route]);
  need(Array.isArray(entry.eligibleRoutes) && entry.eligibleRoutes.length > 0
    && new Set(entry.eligibleRoutes).size === entry.eligibleRoutes.length
    && entry.eligibleRoutes.every(id => [config.selectedRoute, ...config.fallbacks].includes(id))
    && entry.eligibleRoutes.includes(entry.route), 'Decision requires eligible routes and winner');
  need(entry.headroomByDraw && entry.eligibleRoutes.every(id => Object.hasOwn(entry.headroomByDraw, id)
    && (entry.headroomByDraw[id] === null || (Number.isFinite(entry.headroomByDraw[id]) && entry.headroomByDraw[id] >= 0))), 'Decision requires headroom ratios or null');
  const quality = entry.quality;
  need(quality && ['none', 'outcomes.jsonl:pass_rate', 'card:score_mean'].includes(quality.source)
    && Array.isArray(quality.measurements) && typeof quality.measuredDifference === 'boolean', 'Decision requires measured quality basis');
  need(quality.source === 'none' ? quality.measurements.length === 0
    : quality.measurements.length === entry.eligibleRoutes.length
      && entry.eligibleRoutes.every(id => quality.measurements.filter(row => row.route === id
        && Number.isFinite(row.score) && Number.isSafeInteger(row.samples) && row.samples > 0).length === 1), 'Decision quality measurements must cover eligible routes');
  const floor = quality.sampleFloor;
  need(floor?.minimum === QUALITY_SAMPLE_FLOOR && floor.countsByRoute
    && entry.eligibleRoutes.every(id => Number.isSafeInteger(floor.countsByRoute[id]) && floor.countsByRoute[id] >= 0)
    && quality.measurements.every(row => floor.countsByRoute[row.route] === row.samples)
    && floor.applied === entry.eligibleRoutes.some(id => floor.countsByRoute[id] < QUALITY_SAMPLE_FLOOR), 'Decision quality sample floor mismatch');
  need(quality.measuredDifference === (!floor.applied && entry.eligibleRoutes.length > 1
    && new Set(quality.measurements.map(row => row.score)).size > 1), 'Decision quality difference mismatch');
  if (quality.measuredDifference) need(quality.measurements.find(row => row.route === entry.route).score
    === Math.max(...quality.measurements.map(row => row.score)), 'Decision must select higher measured quality');
  need(entry.previousRoute == null || [config.selectedRoute, ...config.fallbacks].includes(entry.previousRoute), 'Previous route outside role allowlist');
  return entry;
}

/** Read the existing outcome log first; card rows provide controlled measurements.
 * Field pass rates describe recorded jobs, not controlled calibration or trust. */
function qualityRecord(role, eligible, outcomes, card, now) {
  const latest = new Map(outcomes.filter(row => nonempty(row?.decisionId)).map(row => [row.decisionId, row]));
  const rows = eligible.map(route => {
    const records = [...latest.values()].filter(row => canonicalRole(row.kind) === canonicalRole(role)
      && row.route === route && ['pass', 'partial', 'fail'].includes(row.result));
    return { route, samples: records.length, score: records.length
      ? records.filter(row => row.result === 'pass').length / records.length : null,
    decisionIds: records.map(row => row.decisionId) };
  });
  let source = 'none';
  let measurements = [];
  if (rows.every(row => row.samples > 0)) {
    source = 'outcomes.jsonl:pass_rate';
    measurements = rows;
  } else if (card?.task === canonicalRole(role) && !isStale(card, new Date(now))
    && Number.isFinite(Date.parse(card.generated)) && Date.parse(card.generated) <= Date.parse(now)) {
    try {
      assertLiveIdentity(card);
      const measured = eligible.map(route => {
        const row = card.models?.find(row => row.model === profile.routes[route].cardIdentity);
        return row && { route, score: row.score_mean, samples: row.completed };
      });
      if (measured.every(row => row && Number.isFinite(row.score) && Number.isSafeInteger(row.samples) && row.samples > 0)) {
        source = 'card:score_mean';
        measurements = measured;
      }
    } catch { /* Quarantined card measurements never enter routing. */ }
  }
  const countsByRoute = Object.fromEntries((measurements.length ? measurements : rows).map(row => [row.route, row.samples]));
  const sampleFloor = { minimum: QUALITY_SAMPLE_FLOOR, countsByRoute,
    applied: eligible.some(id => countsByRoute[id] < QUALITY_SAMPLE_FLOOR) };
  return { source, measurements, sampleFloor, measuredDifference: !sampleFloor.applied && eligible.length > 1
    && new Set(measurements.map(row => row.score)).size > 1 };
}

/** Callers supply comparable headroom/draw ratios. qualityEqual is ignored. */
export function selectFloraRoute({ role, available = [], headroomByDraw = {}, outcomes = [], card,
  now = new Date(), previousRoute = null, boundary = 'dispatch' }) {
  const config = profile.roles[canonicalRole(role)];
  need(config, 'Unknown Flora role');
  need(['dispatch', 'round_boundary'].includes(boundary), 'Route selection requires a round boundary');
  need(!previousRoute || boundary === 'round_boundary', 'A route change requires a round boundary');
  if (config.semanticUse === 'blocked') return { status: 'blocked_identity', owner: 'Roman', route: null };
  const allowed = [config.selectedRoute, ...config.fallbacks];
  const eligible = allowed.filter(id => available.includes(id));
  eligible.forEach(id => assertRoleRoute(role, profile.routes[id]));
  if (!eligible.length) return { status: 'waiting_capacity', owner: 'Roman', route: null };
  const measured = id => Number.isFinite(headroomByDraw[id]) && headroomByDraw[id] >= 0;
  const quality = qualityRecord(role, eligible, outcomes, card, now);
  const contenders = quality.measuredDifference
    ? eligible.filter(id => quality.measurements.find(row => row.route === id).score === Math.max(...quality.measurements.map(row => row.score)))
    : eligible;
  let route = contenders[0];
  let reason = 'equal quality record; approved role route';
  if (contenders.every(measured) && new Set(contenders.map(id => headroomByDraw[id])).size > 1) {
    route = contenders.reduce((best, id) => headroomByDraw[id] > headroomByDraw[best] ? id : best);
    reason = 'equal quality record; greater live headroom relative to expected draw';
  } else if (contenders.includes('sol')) {
    route = 'sol';
    reason = 'equal quality record; Sol first under Decision 1 amendment';
  }
  if (quality.measuredDifference) reason = `higher measured quality for job class (${quality.source})`;
  return { status: 'ok', route, reason, selection_basis: 'approved_profile', eligibleRoutes: eligible,
    headroomByDraw: Object.fromEntries(eligible.map(id => [id, measured(id) ? headroomByDraw[id] : null])), quality };
}

/** A signed receipt is verified by the host callback, never by a caller-supplied boolean. */
export function validateBoard({ authors, reviewers, exception, receipt, commit, contractHash, now, verifyReceipt = () => false }) {
  const hold = reason => ({ status: 'awaiting_approval', owner: 'Roman', callsAllowed: 0, reason });
  try {
    validateFloraCards();
    need(nonempty(commit) && nonempty(contractHash) && Number.isFinite(Date.parse(now)), 'Missing board commit, contract or clock');
    need(Array.isArray(authors) && authors.length > 0 && authors.every(a => nonempty(a.sessionId) && profile.routes[a.route]), 'Full author and repair history required');
    need(Array.isArray(reviewers) && reviewers.length === 2, 'Two eligible reviewers required');
    need(new Set(reviewers.map(r => r.route)).size === 2 && reviewers.some(r => r.route === 'sonnet') && reviewers.some(r => r.route === 'luna'), 'Only approved Sonnet/Luna pair allowed');
    need(new Set(reviewers.map(r => r.sessionId)).size === 2, 'Separate reviewer sessions required');
    for (const reviewer of reviewers) {
      const expected = profile.routes[reviewer.route];
      need(reviewer.model === expected.model && reviewer.vendor === expected.vendor && reviewer.provider === expected.provider && reviewer.cardIdentity === expected.cardIdentity, 'Reviewer route, actual model, provider and card identity must match');
      need(nonempty(reviewer.sessionId) && !authors.some(a => a.sessionId === reviewer.sessionId), 'Author or repair session excluded');
      need(reviewer.readOnly === true && reviewer.isolatedContext === true && reviewer.sealedReports === true, 'Read-only context and sealed reports required');
      for (const author of authors) {
        const route = profile.routes[author.route];
        need(author.model === route.model && author.vendor === route.vendor && author.provider === route.provider, 'Author metadata mismatch');
        if (route.vendor === reviewer.vendor) {
          need(exception?.id === 'flora-decision-3-2026-10-30' && exception.approvalId === 'SETUP-1B:Decision-3' && exception.scope === 'flora-pilot' && Number.isFinite(Date.parse(exception.expiresAt)) && Date.parse(exception.expiresAt) > Date.parse(now), 'Scoped unexpired Decision 3 exception required');
          need(['sonnet', 'sol', 'luna'].includes(author.route), 'Author outside same-vendor exception scope');
        }
      }
    }
    const binding = { authors, reviewers, commit, contractHash, policyHash: hash(rolePolicy), profileHash: hash(profile), exception: exception ?? null };
    need(receipt?.bindingHash === hash(binding) && nonempty(receipt.signature) && verifyReceipt(receipt, binding) === true, 'Signed assignment receipt missing or mismatched');
    return { status: 'ok', callsAllowed: 2, bindingHash: hash(binding) };
  } catch (error) { return hold(error.message); }
}

/** Step 8 consumes this decision; no spawn is released by the card repository. */
export function pickFlora(input, { id, now, limits = {}, outcomes = [], cards = {} }) {
  const at = new Date(now).toISOString();
  const base = { id, at, kind: canonicalRole(input.kind), repo: 'srbryers/FLORA', spawn: null, beforeSpawn: [], alternatives: [], notes: [], why: [], owner: 'Roman', callsAllowed: 0 };
  validateFloraCards();
  if (!input.poolState) return { ...base, status: 'needs_pool_state', why: ['Dispatch and every round boundary require a pool snapshot'] };
  validatePoolState(input.poolState);
  const available = (input.availableRoutes ?? []).filter(route => !(Date.parse(limits[route]) > Date.parse(at)));
  const selected = selectFloraRoute({ role: input.kind, available, outcomes, card: cards[canonicalRole(input.kind)], now: at, headroomByDraw: input.headroomByDraw, previousRoute: input.previousRoute, boundary: input.boundary });
  if (!selected.route) return { ...base, ...selected };
  const decision = { ...base, version: 1, jobId: input.jobId, round: input.round, boundary: input.boundary, previousRoute: input.previousRoute ?? null,
    ...selected, basis: 'policy', policyHash: hash(rolePolicy), profileHash: hash(profile), poolState: input.poolState,
    status: 'awaiting_scheduler', why: [selected.reason, 'Live dispatch hookup belongs to Taura setup step 8'] };
  validateRoutingDecision(decision);
  return decision;
}
