import { resolveCandidates, machineIds } from './policy.mjs';

const WINDOW_MS = { 'five-hour': 5 * 3_600_000, weekly: 7 * 86_400_000 };

export function quotaPace(snapshot, now) {
  if (!snapshot) return 'unknown';
  const result = {};
  for (const [pool, { windows }] of Object.entries(snapshot)) {
    const values = {};
    for (const window of windows) {
      if (Object.hasOwn(window, 'model')) continue;
      const { kind, usedPercent, resetsAt } = window;
      const length = WINDOW_MS[kind];
      const reset = Date.parse(resetsAt);
      if (!length || !Number.isFinite(reset) || !Number.isFinite(usedPercent)
        || usedPercent < 0 || usedPercent > 100 || typeof resetsAt !== 'string'
        || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(resetsAt)) continue;
      // ⚠ Expired snapshots cannot reserve capacity or supply a pace comparison.
      if (reset <= now) continue;
      if (values[kind] && values[kind].used >= usedPercent) continue;
      const elapsed = Math.max(0, Math.min(100, 100 * (now - (reset - length)) / length));
      values[kind] = { used: usedPercent, elapsed, headroom: elapsed - usedPercent };
    }
    if (Object.keys(values).length) result[pool] = values;
  }
  return Object.keys(result).length ? result : 'unknown';
}

/** Pure decision: no clocks, files, commands, credentials or state mutation. */
export function pick(input, deps) {
  const { policy, override = null, repo = null, classifier, alternation = {}, limits = {}, cards = {}, localConfig = null } = deps;
  const now = new Date(deps.now).getTime();
  if (!Number.isFinite(now)) throw new TypeError('now must be a valid date');
  const quota = quotaPace(deps.quota, now);
  const why = [];
  const alternatives = [];
  const notes = [];
  const missingQuota = pool => {
    const windows = policy.pools[pool].windows;
    return !windows.length || windows.some(window => !quota[pool]?.[window]);
  };
  const warnQuota = () => {
    if (!notes.includes('quota unknown: hard stops not applied')) notes.unshift('quota unknown: hard stops not applied');
  };
  if (Object.entries(policy.pools).some(([pool, p]) => p.readable && missingQuota(pool))) warnQuota();
  const result = { id: deps.id, at: new Date(now).toISOString(), status: 'ok', repo, why, alternatives, quota, notes, beforeSpawn: [], spendApproved: input.spendApproved === true };
  if (!input.kind && classifier) result.classifier = { confidence: classifier.confidence, top: classifier.top, costUsd: classifier.costUsd };
  const kind = input.kind ?? (classifier?.status === 'ok' ? classifier.kind : undefined);
  if (!kind) {
    result.status = 'needs_kind';
    result.reason = classifier?.reason ?? (input.execute ? 'missing_brief' : 'dry');
    why.push(result.reason);
    if (classifier && result.reason !== 'dry') result.kindSource = 'jev';
    return result;
  }
  result.kind = kind;
  result.kindSource = input.kind ? 'flag' : 'jev';
  const machines = override?.machines ?? policy.repos[repo]?.machines ?? machineIds(policy);
  const machine = input.machine ?? (machines.length === 1 ? machines[0] : machines.includes(policy.machines.default) ? policy.machines.default : machines[0]);
  result.machine = machine;
  const options = { repo, override, machine, failures: input.failures ?? 0, localConfig };
  const resolved = resolveCandidates(policy, kind, options);
  let candidates = resolved.candidates;
  alternatives.push(...resolved.blocked.map(({ route, why }) => ({ route, rejected: why })));
  // Notes survive even when all candidates have been removed by the resolver.
  for (const rules of [policy.repos[repo], override]) {
    for (const rule of rules?.rules ?? []) {
      if (rule.note && (rule.kinds.includes(kind) || rule.kinds.includes('*')) && !notes.includes(rule.note)) notes.push(rule.note);
    }
  }
  const reject = (candidate, reason) => {
    alternatives.push({ route: candidate.route, rejected: reason });
    why.push(`${candidate.route}: ${reason}`);
    return false;
  };
  const authorVendor = Object.hasOwn(policy.routes, input.author) ? policy.routes[input.author].vendor : input.author;
  const reviewing = policy.review.differentVendor && policy.review.kinds.includes(kind) && authorVendor;
  const vendorAllowed = c => !reviewing || c.vendor !== authorVendor;
  if (reviewing && candidates.length && !candidates.some(vendorAllowed)) {
    why.push(`no candidate from a different vendor than ${authorVendor}; trying nearest tier`);
    const expanded = resolveCandidates(policy, kind, { ...options, reviewFallbacks: true });
    candidates = expanded.candidates;
  }
  const subscriptionCandidates = candidates.slice();
  const limited = new Set();
  const limitReject = (candidate, reason) => {
    limited.add(candidate.route);
    return reject(candidate, reason);
  };
  candidates = candidates.filter(c => vendorAllowed(c) || reject(c, `review must use a different vendor than ${authorVendor}`));
  candidates = candidates.filter(c => !((c.source === 'repo' || c.source === 'file') && c.escalated
    && options.failures >= policy.escalation.escalateAfterFailures)
    || reject(c, 'escalated repo route skipped after repeated failures'));
  candidates = candidates.filter(c => !(Date.parse(limits[c.route]) > now)
    || limitReject(c, `limit cooldown until ${limits[c.route]}`));
  const quotaCandidates = candidates[0]?.type === 'external' ? [] : candidates;
  for (const pool of new Set(quotaCandidates.filter(c => c.type !== 'external').map(c => c.pool))) {
    if (!policy.pools[pool].readable) why.push(`${pool} quota unreadable by design; relying on cooldowns`);
  }
  const unknownPools = [...new Set(quotaCandidates.filter(c => c.type !== 'external'
    && policy.pools[c.pool].readable && missingQuota(c.pool)).map(c => c.pool))];
  if (unknownPools.length) warnQuota();
  if (input.requireQuota && unknownPools.length) {
    result.status = 'blocked';
    why.push(`quota unknown: hard stops not applied; required quota missing for ${unknownPools.join(', ')}`);
    return result;
  }
  candidates = candidates.filter(c => {
    for (const rule of policy.quota.thresholds) {
      const used = quota[rule.pool]?.[rule.window]?.used;
      if (rule.action !== 'reserve-pool' || !(used > rule.usedPercentAbove) || c.pool !== rule.pool) continue;
      if (!rule.allowedTiers.includes(c.tier) && !(rule.allowMainThreads && input.mainThread)) {
        return limitReject(c, `${c.source === 'repo' || c.source === 'file' ? 'repo override blocked: ' : ''}${rule.pool} ${rule.window} ${used}% > ${rule.usedPercentAbove}%; reserved pool`);
      }
    }
    return true;
  });
  let meteredFallback = false;
  // ⚠ Spending is only a response to exhausted subscriptions, never a way around
  // exclusions, machine restrictions, missing configuration or review independence.
  const exhausted = subscriptionCandidates.length > 0
    && subscriptionCandidates.every(c => c.type !== 'external' && !['local', 'metered'].includes(c.pool) && limited.has(c.route))
    && resolved.blocked.every(b => /candidate superseded by/.test(b.why));
  if (!candidates.length && exhausted) {
    const expanded = resolveCandidates(policy, kind, { ...options, meteredFallbacks: true });
    const fallbackIds = policy.quota.meteredFallback[subscriptionCandidates[0].tier] ?? [];
    alternatives.push(...expanded.blocked.filter(b => fallbackIds.includes(b.route)).map(({ route, why }) => ({ route, rejected: why })));
    candidates = expanded.candidates.filter(c => fallbackIds.includes(c.route) && c.pool === 'metered')
      .filter(c => vendorAllowed(c) || reject(c, `review must use a different vendor than ${authorVendor}`))
      .filter(c => !(Date.parse(limits[c.route]) > now) || reject(c, `limit cooldown until ${limits[c.route]}`));
    meteredFallback = candidates.length > 0;
    why.push(meteredFallback ? 'all subscription candidates removed by quota stops or cooldowns; metered fallback order is unmeasured; no card backs it'
      : `no allowed metered fallback for tier ${subscriptionCandidates[0].tier}`);
  }
  if (!candidates.length) {
    result.status = 'blocked';
    why.push(`no allowed route for ${kind} on ${machine}`);
    return result;
  }
  // ⚠ Apply a lone threshold to eligibility before repo priority or card evidence.
  // The fallback may relax this preference, but never resurrect a reserved route.
  for (const tier of new Set(candidates.map(c => c.tier))) {
    const preferences = policy.quota.thresholds.filter(rule => rule.action === 'prefer-route'
      && rule.tiers.includes(tier) && quota[rule.pool]?.[rule.window]?.used > rule.usedPercentAbove);
    if (preferences.length > 1) {
      notes.push('conflicting quota preferences ignored; choose by pace');
      continue;
    }
    if (!preferences.length) continue;
    const rule = preferences[0];
    const losing = c => c.tier === tier && c.pool === rule.pool;
    if (!candidates.some(losing)) continue;
    const targetPool = policy.routes[rule.route].pool;
    if (!candidates.some(c => c.tier === tier && c.pool === targetPool)) {
      notes.push(`quota preference for ${rule.route} unavailable; no allowed ${targetPool} candidate, falling back to ${rule.pool}`);
      continue;
    }
    const poolLabel = { claude: 'Claude', codex: 'Codex' }[rule.pool] ?? rule.pool;
    const windowLabel = rule.window === 'five-hour' ? '5h' : rule.window;
    const reason = `${poolLabel} ${windowLabel} ${quota[rule.pool][rule.window].used}% > ${rule.usedPercentAbove}%`;
    candidates = candidates.filter(c => !losing(c) || reject(c,
      `${c.source === 'repo' || c.source === 'file' ? `repo rule on ${c.route}` : c.route} blocked by quota: ${reason}`));
  }
  let selected = candidates[0];
  let basis = 'policy';
  let tied = false;
  const pair = policy.tieBreak.routes.map(id => candidates.find(c => c.route === id));
  const repoFirst = selected.source === 'repo' || selected.source === 'file';
  if (!repoFirst && selected.tier === policy.tieBreak.tier && pair.every(Boolean)) {
    const heads = pair.map(c => quota[c.pool]?.[policy.tieBreak.window]?.headroom);
    if (heads.every(Number.isFinite)) {
      why.push(`${pair[0].route} weekly headroom ${heads[0].toFixed(2)} points; ${pair[1].route} weekly headroom ${heads[1].toFixed(2)} points`);
      tied = Math.abs(heads[0] - heads[1]) <= policy.tieBreak.marginPoints;
      if (!tied) selected = pair[heads[0] > heads[1] ? 0 : 1];
    } else {
      tied = true;
      why.push('weekly pace unavailable for one or both pools; no evidence to prefer either');
    }
    if (tied) {
      selected = pair.find(c => c.route !== alternation[kind]) ?? pair[0];
      basis = 'trial';
      why.push(`alternate ${policy.tieBreak.routes.join('/')}; tie margin ${policy.tieBreak.marginPoints} points; last trial ${alternation[kind] ?? 'none'}`);
    }
  }
  const file = policy.cards.byKind[kind];
  const card = cards[kind];
  if (!file) why.push(`no card mapped for ${kind}`);
  else if (!card) why.push(`no card file present: ${file}`);
  else if (meteredFallback) why.push('card ignored: metered fallback order is unmeasured; no card backs it');
  else if (repoFirst) why.push('repo rule outranks card');
  else if (card.task !== file.slice(0, -'.card.json'.length)) why.push(`card task mismatch: expected ${file.slice(0, -'.card.json'.length)}, ignored`);
  else if (selected.type === 'external') why.push('external instruction takes precedence over worker cards');
  else {
    const label = `card ${card.task ?? kind} ${card.trust ?? 'invalid'}`;
    const age = (now - Date.parse(card.generated)) / 86_400_000;
    const winner = candidates.find(c => ['tier', 'kind'].includes(c.source) && policy.routes[c.route].cardModels?.includes(card.recommend));
    if (!Number.isFinite(age) || age < 0 || age >= policy.cards.maxAgeDays) why.push(`${label}, stale or invalid date, ignored`);
    else if (card.trust === 'CALIBRATED' && winner) {
      selected = winner; basis = 'card'; why.push(`${label}, fresh winner maps to allowed route ${winner.route}`);
    } else if (card.trust === 'NO_CLEAR_WINNER' && tied && winner && pair.includes(winner)) {
      const rows = pair.map(c => (Array.isArray(card.models) ? card.models : []).find(row => policy.routes[c.route].cardModels?.includes(row.model)));
      const costs = rows.map(row => row?.cost_per_accepted_usd);
      const winIndex = pair.indexOf(winner);
      if (costs.every(c => typeof c === 'number' && Number.isFinite(c) && c >= 0)
        && rows[0].cost_source === rows[1].cost_source && costs[winIndex] < costs[1 - winIndex]) {
        selected = winner; basis = 'card-cheaper'; why.push(`${label}, within pace tie; measured cost per accepted result ${costs[winIndex]} < ${costs[1 - winIndex]}`);
      } else why.push(`${label}, costs unknown, incomparable or not cheaper, ignored`);
    } else why.push(`${label}, ${card.trust === 'CALIBRATED' ? 'winner not allowed' : card.trust === 'NO_CLEAR_WINNER' ? 'no eligible pace tie' : 'insufficient evidence'}, ignored`);
  }
  why.unshift(`tier ${selected.tier} for ${kind}`);
  why.push(selected.reason);
  if (quota === 'unknown') why.push('quota unknown');
  for (const c of candidates) {
    if (c.route !== selected.route) alternatives.push({ route: c.route, rejected: `selected ${selected.route} by ${basis}: ${why.slice(1).join('; ')}` });
  }
  Object.assign(result, { route: selected.route, basis });
  if (selected.type === 'external') {
    Object.assign(result, { status: 'external', instruction: selected.instruction, requiresSpendApproval: selected.requiresSpendApproval });
  } else {
    Object.assign(result, { provider: selected.provider, model: selected.model, reasoning: selected.reasoning });
    const route = policy.routes[selected.route];
    if (route.note && !notes.includes(route.note)) notes.push(route.note);
    if (route.requiresSpendApproval) {
      Object.assign(result, { requiresSpendApproval: true, costPer1M: route.costPer1M,
        status: input.spendApproved ? 'ok' : 'needs_approval' });
    }
    if (route.runningByDefault === false && route.livenessCheck) {
      result.beforeSpawn.push(`Check the local server is running: \`${route.livenessCheck}\``);
    }
  }
  return result;
}
