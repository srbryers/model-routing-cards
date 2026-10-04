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
  const { policy, override = null, repo = null, classifier, alternation = {}, poolAlternation = {}, limits = {}, cards = {}, localConfig = null, localConfigError = null } = deps;
  const approvedRoutes = input.approvedRoutes ?? [];
  if (!Array.isArray(approvedRoutes) || approvedRoutes.some(route => typeof route !== 'string' || !Object.hasOwn(policy.routes, route))) {
    throw new TypeError('approvedRoutes must be a list of known route IDs');
  }
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
  const result = { id: deps.id, at: new Date(now).toISOString(), status: 'ok', repo, why, alternatives, quota, notes, beforeSpawn: [], approvedRoutes: [...new Set(approvedRoutes)], spendApproved: false };
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
  const options = { repo, override, machine, failures: input.failures ?? 0, localConfig, localConfigError };
  const resolved = resolveCandidates(policy, kind, options);
  let candidates = resolved.candidates;
  alternatives.push(...resolved.blocked.map(({ route, why }) => ({ route, rejected: why })));
  // Notes survive even when all candidates have been removed by the resolver.
  for (const rules of [policy.repos[repo], override]) {
    for (const rule of rules?.rules ?? []) {
      if (!rule.kinds.includes(kind) && !rule.kinds.includes('*')) continue;
      if (rule.note && !notes.includes(rule.note)) notes.push(rule.note);
      if (policy.routes[rule.route]?.disabled) {
        const note = `repo rule names ${rule.route}, which is disabled: ${policy.routes[rule.route].disabled}`;
        if (!notes.includes(note)) notes.push(note);
      }
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
  // ⚠ Why a subscription route was removed decides whether metered may be offered:
  // 'cooldown' and 'ceiling' allow it; 'reserve' (the Claude 80% rule) never does.
  const limited = new Map();
  const limitReject = (candidate, reason, cause) => {
    limited.set(candidate.route, cause);
    return reject(candidate, reason);
  };
  const windowLabel = window => (window === 'five-hour' ? '5h' : window);
  candidates = candidates.filter(c => vendorAllowed(c) || reject(c, `review must use a different vendor than ${authorVendor}`));
  candidates = candidates.filter(c => !((c.source === 'repo' || c.source === 'file') && c.escalated
    && options.failures >= policy.escalation.escalateAfterFailures)
    || reject(c, 'escalated repo route skipped after repeated failures'));
  candidates = candidates.filter(c => !(Date.parse(limits[c.route]) > now)
    || limitReject(c, `limit cooldown until ${limits[c.route]}`, 'cooldown'));
  // ⚠ A pool with any readable window at the ceiling is exhausted: all its routes go,
  // repo rules and main threads included.
  const ceiling = policy.quota.ceilingPercent;
  candidates = candidates.filter(c => {
    const full = Object.entries(quota[c.pool] ?? {}).find(([, value]) => value.used >= ceiling);
    return !full || limitReject(c, `${c.pool} ${windowLabel(full[0])} ${full[1].used}% ≥ ${ceiling}% ceiling: pool exhausted`, 'ceiling');
  });
  const quotaCandidates = candidates[0]?.type === 'external' ? [] : candidates;
  for (const pool of new Set(quotaCandidates.filter(c => c.type !== 'external').map(c => c.pool))) {
    if (!policy.pools[pool].readable) why.push(`${pool} quota unreadable by design; relying on cooldowns`);
  }
  candidates = candidates.filter(c => {
    for (const rule of policy.quota.thresholds) {
      const used = quota[rule.pool]?.[rule.window]?.used;
      if (rule.action !== 'reserve-pool' || !(used > rule.usedPercentAbove) || c.pool !== rule.pool) continue;
      if (!rule.allowedTiers.includes(c.tier) && !(rule.allowMainThreads && input.mainThread)) {
        return limitReject(c, `${c.source === 'repo' || c.source === 'file' ? 'repo override blocked: ' : ''}${rule.pool} ${rule.window} ${used}% > ${rule.usedPercentAbove}%; reserved pool`, 'reserve');
      }
    }
    return true;
  });
  let meteredFallback = false;
  // ⚠ Spending is only a response to exhausted subscriptions, never a way around
  // exclusions, machine restrictions, missing configuration or review independence.
  // A route held back only by the Claude reserve is not exhausted: Sebastian decides.
  const allLimited = subscriptionCandidates.length > 0
    && subscriptionCandidates.every(c => c.type !== 'external' && !['local', 'metered'].includes(c.pool) && limited.has(c.route))
    && resolved.blocked.every(b => /candidate superseded by/.test(b.why));
  const reserved = subscriptionCandidates.filter(c => limited.get(c.route) === 'reserve');
  const exhausted = allLimited && !reserved.length;
  if (!candidates.length && allLimited && reserved.length) {
    why.push(`${reserved.map(c => c.route).join(', ')} held back only by the Claude reserve while other subscriptions are exhausted; metered not offered, owner decides`);
  }
  if (!candidates.length && exhausted) {
    const expanded = resolveCandidates(policy, kind, { ...options, meteredFallbacks: true });
    const fallbackIds = policy.quota.meteredFallback[subscriptionCandidates[0].tier] ?? [];
    alternatives.push(...expanded.blocked.filter(b => fallbackIds.includes(b.route)).map(({ route, why }) => ({ route, rejected: why })));
    candidates = expanded.candidates.filter(c => fallbackIds.includes(c.route) && c.pool === 'metered')
      .filter(c => vendorAllowed(c) || reject(c, `review must use a different vendor than ${authorVendor}`))
      .filter(c => !(Date.parse(limits[c.route]) > now) || reject(c, `limit cooldown until ${limits[c.route]}`));
    meteredFallback = candidates.length > 0;
    why.push(meteredFallback ? 'all subscription candidates removed by the quota ceiling or cooldowns; metered fallback order is unmeasured; no card backs it'
      : `no allowed metered fallback for tier ${subscriptionCandidates[0].tier}`);
  }
  if (!candidates.length) {
    result.status = 'blocked';
    why.push(`no allowed route for ${kind} on ${machine}`);
    return result;
  }
  // ⚠ Apply a lone threshold to eligibility before repo priority or card evidence.
  // The fallback may relax this preference, but never resurrect a reserved route.
  const preferencePools = new Set();
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
    preferencePools.add(rule.pool); preferencePools.add(targetPool);
    const poolLabel = { claude: 'Claude', codex: 'Codex' }[rule.pool] ?? rule.pool;
    const windowLabel = rule.window === 'five-hour' ? '5h' : rule.window;
    const reason = `${poolLabel} ${windowLabel} ${quota[rule.pool][rule.window].used}% > ${rule.usedPercentAbove}%`;
    candidates = candidates.filter(c => !losing(c) || reject(c,
      `${c.source === 'repo' || c.source === 'file' ? `repo rule on ${c.route}` : c.route} blocked by quota: ${reason}`));
  }
  let selected = candidates[0];
  let basis = 'policy';
  let paceUsed = false;
  // ⚠ Pace chooses a pool; routes that share the winning pool have no evidence between
  // them, so they alternate. A pace tie rotates over every allowed tie-break route.
  const tie = policy.tieBreak;
  const group = tie.routes.map(id => candidates.find(c => c.route === id)).filter(Boolean);
  const repoFirst = selected.source === 'repo' || selected.source === 'file';
  let rotation = [];
  let lastTrial;
  if (!repoFirst && selected.tier === tie.tier && group.length >= 2) {
    const pools = [...new Set(group.map(c => c.pool))];
    rotation = group;
    if (pools.length > 1) {
      paceUsed = true;
      const heads = pools.map(pool => quota[pool]?.[tie.window]?.headroom);
      if (heads.every(Number.isFinite)) {
        // Label each pool by its first route so the pace line names the routes compared.
        why.push(pools.map((pool, i) => `${group.find(c => c.pool === pool).route} weekly headroom ${heads[i].toFixed(2)} points`).join('; '));
        const ranked = pools.map((pool, i) => ({ pool, head: heads[i] })).sort((a, b) => b.head - a.head);
        if (ranked[0].head - ranked[1].head > tie.marginPoints) {
          rotation = group.filter(c => c.pool === ranked[0].pool);
          if (rotation.length > 1) why.push(`${ranked[0].pool} pool leads by pace; its routes have no evidence between them`);
        }
      } else why.push('weekly pace unavailable for one or both pools; no evidence to prefer either');
    } else why.push(`only the ${pools[0]} pool is allowed; its routes have no evidence between them`);
    if (rotation.length > 1) {
      const rotatingPools = new Set(rotation.map(c => c.pool));
      // Alternation is keyed per kind, and per pool when the rotation stays inside one pool.
      lastTrial = rotatingPools.size === 1
        ? poolAlternation[kind]?.[rotation[0].pool]
          ?? (policy.routes[alternation[kind]]?.pool === rotation[0].pool ? alternation[kind] : undefined)
        : alternation[kind];
      const start = tie.routes.indexOf(lastTrial);
      let next;
      for (let step = 1; step <= tie.routes.length && !next; step++) {
        next = rotation.find(c => c.route === tie.routes[(start + step) % tie.routes.length]);
      }
      selected = next;
      basis = 'trial';
      why.push(`alternate ${rotation.map(c => c.route).join('/')}; tie margin ${tie.marginPoints} points; last trial ${lastTrial ?? 'none'}`);
    } else selected = rotation[0];
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
    } else if (card.trust === 'NO_CLEAR_WINNER' && rotation.length > 1 && winner && rotation.includes(winner)) {
      const rows = rotation.map(c => (Array.isArray(card.models) ? card.models : []).find(row => policy.routes[c.route].cardModels?.includes(row.model)));
      const costs = rows.map(row => row?.cost_per_accepted_usd);
      const winIndex = rotation.indexOf(winner);
      const others = costs.filter((_, i) => i !== winIndex);
      // ⚠ A rotation route with no measured row cannot be shown more expensive.
      if (costs.every(c => typeof c === 'number' && Number.isFinite(c) && c >= 0)
        && rows.every(row => row.cost_source === rows[0].cost_source) && others.every(c => costs[winIndex] < c)) {
        selected = winner; basis = 'card-cheaper'; why.push(`${label}, within tie; measured cost per accepted result ${costs[winIndex]} < ${Math.min(...others)}`);
      } else why.push(`${label}, costs unknown, incomparable or not cheaper, ignored`);
    } else why.push(`${label}, ${card.trust === 'CALIBRATED' ? 'winner not allowed' : card.trust === 'NO_CLEAR_WINNER' ? 'no eligible pace tie' : 'insufficient evidence'}, ignored`);
  }
  // ⚠ Unused fallback pools cannot block a choice they did not influence.
  const relevantPools = new Set(preferencePools.has(selected.pool) ? preferencePools : []);
  if (selected.type !== 'external') relevantPools.add(selected.pool);
  if (paceUsed && basis !== 'card') for (const c of group) relevantPools.add(c.pool);
  const unknownPools = [...relevantPools].filter(pool => policy.pools[pool].readable && missingQuota(pool));
  if (input.requireQuota && unknownPools.length && selected.type !== 'external') {
    result.status = 'blocked';
    why.push(`quota unknown: hard stops not applied; required quota missing for ${unknownPools.join(', ')}`);
    return result;
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
    if (kind === 'bulk-text' && selected.route !== 'pi-local' && selected.pool !== 'local') {
      notes.push(`pi-local unavailable; falling back to ${selected.route} (cloud). Do not send private text.`);
    }
    if (route.note && !notes.includes(route.note)) notes.push(route.note);
    if (route.requiresSpendApproval) {
      // ⚠ A cooldown or policy change may choose a different paid route on retry.
      result.spendApproved = result.approvedRoutes.includes(selected.route);
      if (!result.spendApproved && result.approvedRoutes.length) {
        why.push(`approval covers ${result.approvedRoutes.join(',')}; selected ${selected.route}`);
      }
      Object.assign(result, { requiresSpendApproval: true, costPer1M: route.costPer1M,
        status: result.spendApproved ? 'ok' : 'needs_approval',
        ...(!result.spendApproved ? { spawn: null } : {}) });
    }
    if (route.runningByDefault === false && route.livenessCheck) {
      result.beforeSpawn.push(`Check the local server is running: \`${route.livenessCheck}\``);
    }
  }
  return result;
}
