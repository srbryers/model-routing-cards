import { resolveCandidates } from './policy.mjs';

const WINDOW_MS = { 'five-hour': 5 * 3_600_000, weekly: 7 * 86_400_000 };

export function quotaPace(snapshot, now) {
  if (!snapshot) return 'unknown';
  const result = {};
  for (const [pool, { windows }] of Object.entries(snapshot)) {
    const values = {};
    for (const { kind, usedPercent, resetsAt } of windows) {
      const length = WINDOW_MS[kind];
      const reset = Date.parse(resetsAt);
      if (!length || !Number.isFinite(reset) || !Number.isFinite(usedPercent)) continue;
      // ⚠ Expired snapshots cannot reserve capacity or supply a pace comparison.
      if (reset <= now) continue;
      const elapsed = 100 * (now - (reset - length)) / length;
      values[kind] = { used: usedPercent, elapsed, headroom: elapsed - usedPercent };
    }
    if (Object.keys(values).length) result[pool] = values;
  }
  return Object.keys(result).length ? result : 'unknown';
}

/** Pure decision: no clocks, files, commands, credentials or state mutation. */
export function pick(input, deps) {
  const { policy, override = null, repo = null, classifier, alternation = {}, limits = {}, cards = {} } = deps;
  const now = new Date(deps.now).getTime();
  if (!Number.isFinite(now)) throw new TypeError('now must be a valid date');
  const quota = quotaPace(deps.quota, now);
  const why = [];
  const alternatives = [];
  const notes = [];
  const result = { id: deps.id, at: new Date(now).toISOString(), status: 'ok', repo, why, alternatives, quota, notes };
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
  const machines = override?.machines ?? policy.repos[repo]?.machines ?? Object.keys(policy.machines);
  const machine = input.machine ?? (machines.length === 1 ? machines[0] : 'mac-studio');
  result.machine = machine;
  const options = { repo, override, machine, failures: input.failures ?? 0 };
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
  candidates = candidates.filter(c => vendorAllowed(c) || reject(c, `review must use a different vendor than ${authorVendor}`));
  candidates = candidates.filter(c => !((c.source === 'repo' || c.source === 'file') && c.escalated
    && options.failures >= policy.escalation.escalateAfterFailures)
    || reject(c, 'escalated repo route skipped after repeated failures'));
  candidates = candidates.filter(c => !(Date.parse(limits[c.route]) > now)
    || reject(c, `limit cooldown until ${limits[c.route]}`));
  candidates = candidates.filter(c => {
    for (const rule of policy.quota.thresholds) {
      const used = quota[rule.pool]?.[rule.window]?.used;
      if (!(used > rule.usedPercentAbove) || c.pool !== rule.pool) continue;
      const blocked = rule.action === 'reserve-pool'
        ? !rule.allowedTiers.includes(c.tier) && !(rule.allowMainThreads && input.mainThread)
        : rule.tiers.includes(c.tier);
      if (blocked) return reject(c, `${c.source === 'repo' || c.source === 'file' ? 'repo override blocked: ' : ''}${rule.pool} ${rule.window} ${used}% > ${rule.usedPercentAbove}%${rule.action === 'prefer-route' ? `; prefer ${rule.route}` : '; reserved pool'}`);
    }
    return true;
  });
  if (!candidates.length) {
    result.status = 'blocked';
    why.push(`no allowed route for ${kind} on ${machine}`);
    return result;
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
  else if (selected.type === 'external') why.push('external instruction takes precedence over worker cards');
  else {
    const label = `card ${card.task ?? kind} ${card.trust ?? 'invalid'}`;
    const age = (now - Date.parse(card.generated)) / 86_400_000;
    const winner = candidates.find(c => policy.routes[c.route].cardModels?.includes(card.recommend));
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
    if (policy.routes[selected.route].runningByDefault === false) notes.push('Local worker is not running by default; start it and check availability before dispatch.');
  }
  return result;
}
