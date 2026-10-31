import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { profile, rolePolicy, hash, loadFloraCards, validateFloraCards, assertRoleRoute, selectFloraRoute, validateBoard, validateRoutingDecision, pickFlora } from './flora.mjs';
import { call } from './providers.mjs';
import { pick } from './pick.mjs';
import { loadPolicy, validatePolicy } from './policy.mjs';
const at = '2026-10-30T16:00:00.000Z';
const snapshot = JSON.parse(readFileSync(new URL('../policy/flora/pool-state.example.json', import.meta.url), 'utf8'));
const decision = () => ({ version: 1, id: 'decision-1', jobId: 'flora-385', at, round: 1, kind: 'flora-ui-builder', route: 'sol', previousRoute: null, boundary: 'dispatch', reason: 'equal quality record; Sol first', basis: 'policy', selection_basis: 'approved_profile', policyHash: hash(rolePolicy), profileHash: hash(profile), poolState: structuredClone(snapshot), eligibleRoutes: ['sonnet', 'sol'], headroomByDraw: { sonnet: null, sol: null }, quality: { source: 'none', measurements: [], sampleFloor: { minimum: 3, countsByRoute: { sonnet: 0, sol: 0 }, applied: true }, measuredDifference: false } });

test('Flora check exits zero for live cards and one for the stale fixture with zero provider calls', () => {
  const check = fileURLToPath(new URL('./flora.check.mjs', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/flora-stale-luna.card.json', import.meta.url));
  const live = spawnSync(process.execPath, [check], { encoding: 'utf8' });
  assert.equal(live.status, 0, live.stderr);
  assert.equal(JSON.parse(live.stdout).providerCalls, 0);
  const stale = spawnSync(process.execPath, [check, fixture], { encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Stale Luna identity.*providerCalls=0/);
});

test('live eleven-card set passes and stale Luna fixture fails before any provider call', async () => {
  assert.equal(validateFloraCards().cards, 11);
  const cards = loadFloraCards();
  cards[cards.findIndex(card => card.task === 'flora-review-codex')] = JSON.parse(readFileSync(new URL('./fixtures/flora-stale-luna.card.json', import.meta.url), 'utf8'));
  assert.throws(() => validateFloraCards(cards), /Stale Luna/);
  let calls = 0;
  await assert.rejects(call({ provider: 'codex', model: 'gpt-6-luna' }, { prompt: '', spawn: () => { calls++; } }), /Stale Luna/);
  assert.equal(calls, 0);
  const policy = structuredClone(loadPolicy());
  policy.routes.luna.cardModels = ['openai/gpt-6-luna'];
  assert.equal(validatePolicy(policy).ok, false);
});

test('forbidden providers and fallback classes fail role policy', () => {
  for (const provider of ['pi', 'openrouter']) assert.throws(() => assertRoleRoute('flora-ui-builder', { ...profile.routes.sonnet, provider }), /Claude requires/);
  assert.throws(() => assertRoleRoute('flora-ui-builder', profile.routes.opus), /prohibited/);
  for (const role of Object.keys(profile.roles)) {
    for (const id of [profile.roles[role].selectedRoute, ...profile.roles[role].fallbacks]) assert.doesNotThrow(() => assertRoleRoute(role, profile.routes[id]));
  }
});

test('orchestrator uses Muse Wonder per Sebastian decision 2026-10-31, outside Setup 1b', () => {
  const config = profile.roles['flora-orchestrator'];
  assert.equal(config.selectedRoute, 'muse-wonder');
  assert.deepEqual(profile.routes[config.selectedRoute], {
    model: 'muse-wonder', cardIdentity: 'meta/muse-wonder', provider: 'muse',
    vendor: 'meta', pool: 'muse', modelClass: 'orchestrator',
  });
  assert.deepEqual(config.origin, {
    source: 'Sebastian decision 2026-10-31, Mahi + Taura chat',
    decision: '2026-10-31', scope: 'flora-pilot',
    note: "The earlier Sonnet entry came from PLAN.md's proposal; Setup 1b never named an orchestrator route.",
  });
  assert.equal(config.effortSource, 'provider default on the Muse platform');
  assert.deepEqual(config.fallbacks, []);
  assert.equal(config.status, 'UNCALIBRATED');
  const card = loadFloraCards().find(card => card.task === 'flora-orchestrator');
  assert.deepEqual(card.modelConfig, config);
  assert.equal(selectFloraRoute({ role: 'flora-router-reconciler', available: ['muse-wonder'] }).route, 'muse-wonder');
  assert.equal(selectFloraRoute({ role: 'flora-orchestrator', available: ['sonnet', 'muse'] }).status, 'waiting_capacity');
  assert.throws(() => assertRoleRoute('flora-orchestrator', profile.routes.sonnet), /prohibited/);
  assert.throws(() => assertRoleRoute('flora-orchestrator', { ...profile.routes['muse-wonder'], provider: 'acp-muse' }), /prohibited/);
});

test('Muse Wonder platform identity pin rejects drift without bypassing generic route checks', () => {
  const route = profile.routes['muse-wonder'];
  for (const field of Object.keys(route)) {
    const original = route[field];
    try {
      route[field] = 'unapproved';
      assert.throws(() => validateFloraCards(), /Muse Wonder platform seat identity mismatch/);
    } finally {
      route[field] = original;
    }
  }
  try {
    profile.routes['unapproved-platform'] = { ...route };
    assert.throws(() => validateFloraCards(), /Live policy and Flora route identity mismatch/);
  } finally {
    delete profile.routes['unapproved-platform'];
  }
});

test('only eligible roles compete; quota, failures, overrides and card winners cannot widen routes', () => {
  assert.equal(selectFloraRoute({ role: 'flora-ui-builder', available: ['sonnet', 'sol', 'opus'], qualityEqual: true }).route, 'sol');
  assert.equal(selectFloraRoute({ role: 'flora-ui-builder', available: ['sonnet', 'sol'], qualityEqual: true, headroomByDraw: { sonnet: 3, sol: 1 } }).route, 'sonnet');
  assert.equal(selectFloraRoute({ role: 'flora-general-builder', available: ['opus', 'astra', 'muse'] }).status, 'waiting_capacity');
  assert.equal(selectFloraRoute({ role: 'flora-ui-elevation', available: ['opus', 'sol'] }).route, null);
  assert.equal(selectFloraRoute({ role: 'flora-judge', available: ['jev'] }).status, 'blocked_identity');
  const input = { kind: 'flora-general-builder', poolState: snapshot, availableRoutes: ['opus', 'astra', 'sol'], failures: 100, jobId: 'job', round: 1, boundary: 'dispatch', approvedRoutes: ['opus'] };
  const deps = { id: 'decision', now: at, policy: loadPolicy(), override: { rules: [{ route: 'opus' }] }, cards: { 'flora-general-builder': { trust: 'CALIBRATED', recommend: 'anthropic/claude-opus-5-5' } } };
  assert.equal(pick(input, deps).route, 'sol');
  assert.equal(pick(input, { ...deps, limits: { sol: '2026-10-31T00:00:00Z' } }).status, 'waiting_capacity');
  assert.equal(pick({ kind: 'ui-visual' }, { ...deps, repo: 'srbryers/FLORA' }).status, 'needs_kind');
});

test('cheaper live route wins by default and qualityEqual cannot gate it', () => {
  const input = { kind: 'flora-ui-builder', poolState: snapshot, availableRoutes: ['sonnet', 'sol'],
    headroomByDraw: { sonnet: 1, sol: 4 }, jobId: 'job', round: 1, boundary: 'dispatch' };
  for (const qualityEqual of [undefined, false, true]) {
    const d = pickFlora({ ...input, qualityEqual }, { id: 'decision', now: at });
    assert.equal(d.route, 'sol');
    assert.deepEqual(d.eligibleRoutes, ['sonnet', 'sol']);
    assert.deepEqual(d.headroomByDraw, input.headroomByDraw);
    assert.equal(d.quality.measuredDifference, false);
    assert.doesNotThrow(() => validateRoutingDecision(d));
  }
  assert.equal(pickFlora({ ...input, headroomByDraw: { sonnet: 4, sol: 1 } }, { id: 'd', now: at }).route, 'sonnet');
});

test('outcome record for the job class overrides cheaper headroom without promoting trust', () => {
  const input = { kind: 'flora-ui-builder', poolState: snapshot, availableRoutes: ['sonnet', 'sol'],
    headroomByDraw: { sonnet: 1, sol: 4 }, jobId: 'job', round: 1, boundary: 'dispatch' };
  const outcomes = ['sonnet', 'sol'].flatMap(route => Array.from({ length: 3 }, (_, i) =>
    ({ decisionId: `${route}-${i}`, kind: input.kind, route, result: route === 'sonnet' ? 'pass' : 'fail' })));
  const d = pickFlora(input, { id: 'd', now: at, outcomes });
  assert.equal(d.route, 'sonnet');
  assert.equal(d.quality.source, 'outcomes.jsonl:pass_rate');
  assert.equal(d.quality.measuredDifference, true);
  assert.match(d.reason, /higher measured quality/);
  assert.doesNotThrow(() => validateRoutingDecision(d));
  for (const records of [outcomes.slice(0, 1), outcomes.map(r => ({ ...r, kind: 'flora-general-builder' })),
    outcomes.map(r => ({ ...r, result: 'pass' })), outcomes.map(r => ({ ...r, result: 'abandoned' }))]) {
    assert.equal(pickFlora(input, { id: 'd', now: at, outcomes: records }).route, 'sol');
  }
  assert.equal(loadFloraCards().find(c => c.task === input.kind).trust, 'UNCALIBRATED');
});

for (const [sonnet, sol, expected] of [[2, 5, 'sol'], [3, 3, 'sonnet'], [3, 2, 'sol'], [3, 0, 'sol']]) {
  test(`quality sample floor: ${sonnet} vs ${sol} outcomes selects ${expected}`, () => {
    const input = { kind: 'flora-ui-builder', poolState: snapshot, availableRoutes: ['sonnet', 'sol'],
      headroomByDraw: { sonnet: 1, sol: 4 }, jobId: 'job', round: 1, boundary: 'dispatch' };
    const outcomes = Object.entries({ sonnet, sol }).flatMap(([route, count]) => Array.from({ length: count }, (_, i) =>
      ({ decisionId: `${route}-${i}`, kind: input.kind, route, result: route === 'sonnet' ? 'pass' : 'fail' })));
    const d = pickFlora(input, { id: 'd', now: at, outcomes });
    assert.equal(d.route, expected);
    assert.deepEqual(d.quality.sampleFloor, { minimum: 3, countsByRoute: { sonnet, sol }, applied: sonnet < 3 || sol < 3 });
    assert.equal(d.quality.measuredDifference, sonnet >= 3 && sol >= 3);
    assert.doesNotThrow(() => validateRoutingDecision(d));
    for (const mutate of [d => d.quality.sampleFloor.applied = !d.quality.sampleFloor.applied,
      d => d.quality.sampleFloor.minimum = 2, d => delete d.quality.sampleFloor.countsByRoute.sol,
      d => d.quality.sampleFloor.countsByRoute.sonnet = -1]) {
      const broken = structuredClone(d); mutate(broken);
      assert.throws(() => validateRoutingDecision(broken), /sample floor/);
    }
  });
}

test('existing card measured rows supply quality, but stale or incomplete cards do not', () => {
  const card = { task: 'flora-ui-builder', generated: at, expires_days: 30, models: [
    { model: profile.routes.sonnet.cardIdentity, score_mean: 0.9, completed: 3 },
    { model: profile.routes.sol.cardIdentity, score_mean: 0.5, completed: 3 },
  ] };
  const args = { role: card.task, available: ['sonnet', 'sol'], headroomByDraw: { sonnet: 1, sol: 4 }, now: at, card };
  const selected = selectFloraRoute(args);
  assert.equal(selected.route, 'sonnet');
  assert.equal(selected.quality.source, 'card:score_mean');
  for (const route of ['sonnet', 'sol']) {
    const thinCard = structuredClone(card);
    thinCard.models.find(row => row.model === profile.routes[route].cardIdentity).completed = 2;
    const thin = selectFloraRoute({ ...args, card: thinCard });
    assert.equal(thin.route, 'sol');
    assert.equal(thin.quality.sampleFloor.applied, true);
    assert.equal(thin.quality.measuredDifference, false);
  }
  assert.equal(selectFloraRoute({ ...args, card: { ...card, generated: '2025-01-01' } }).route, 'sol');
  assert.equal(selectFloraRoute({ ...args, card: { ...card, models: card.models.slice(0, 1) } }).route, 'sol');
});

test('dated routing example rejects stale binding and current quality receipts validate', () => {
  const example = JSON.parse(readFileSync(new URL('../policy/flora/routing-decision.example.json', import.meta.url), 'utf8'));
  assert.throws(() => validateRoutingDecision(example), /Decision policy or profile hash mismatch/);
  assert.doesNotThrow(() => validateRoutingDecision({ ...example, policyHash: hash(rolePolicy), profileHash: hash(profile) }));
  for (const mutate of [d => delete d.eligibleRoutes, d => delete d.quality,
    d => d.quality.measuredDifference = true, d => delete d.headroomByDraw.sol]) {
    const d = decision(); mutate(d); assert.throws(() => validateRoutingDecision(d));
  }
});

test('pool snapshots and decision reasons are mandatory, route changes require round boundaries', () => {
  assert.doesNotThrow(() => validateRoutingDecision(decision()));
  for (const mutation of [d => delete d.poolState, d => delete d.poolState.codex.credits, d => d.poolState.costUsd = 0, d => d.boundary = 'mid_round', d => d.previousRoute = 'sonnet', d => d.route = 'opus', d => d.poolState.capturedAt = '2026-10-29T00:00:00Z']) {
    const d = decision(); mutation(d); assert.throws(() => validateRoutingDecision(d));
  }
  const d = decision(); d.previousRoute = 'sonnet'; d.boundary = 'round_boundary'; d.round = 2;
  assert.doesNotThrow(() => validateRoutingDecision(d));
  assert.equal(pickFlora({ kind: 'flora-ui-builder' }, { id: 'id', now: at }).status, 'needs_pool_state');
});

const author = route => ({ route, sessionId: `author-${route}`, model: profile.routes[route].model, vendor: profile.routes[route].vendor, provider: profile.routes[route].provider });
function board(routes = ['sol']) {
  return { authors: routes.map(author), reviewers: ['sonnet', 'luna'].map(route => ({ route, model: profile.routes[route].model, vendor: profile.routes[route].vendor, provider: profile.routes[route].provider, cardIdentity: profile.routes[route].cardIdentity, sessionId: `review-${route}`, readOnly: true, isolatedContext: true, sealedReports: true })), exception: { id: 'flora-decision-3-2026-10-30', approvalId: 'SETUP-1B:Decision-3', scope: 'flora-pilot', expiresAt: '2026-11-01T00:00:00Z' }, commit: 'commit', contractHash: 'contract', now: at };
}
const signature = binding => createHmac('sha256', 'offline-fixture-key').update(JSON.stringify(binding)).digest('hex');
function sign(b) {
  const binding = { authors: b.authors, reviewers: b.reviewers, commit: b.commit, contractHash: b.contractHash, policyHash: hash(rolePolicy), profileHash: hash(profile), exception: b.exception ?? null };
  b.receipt = { bindingHash: hash(binding), signature: signature(binding) };
  b.verifyReceipt = (receipt, bound) => receipt.signature === signature(bound);
  return b;
}
test('board matrix allows only approved author scopes with signed fresh-session assignments', () => {
  for (const routes of [['sonnet'], ['sol'], ['luna'], ['sonnet', 'sol', 'luna']]) assert.equal(validateBoard(sign(board(routes))).callsAllowed, 2);
  for (const routes of [['opus'], ['astra'], ['sonnet', 'astra']]) assert.equal(validateBoard(sign(board(routes))).callsAllowed, 0);
});
test('no eligible pair, session reuse, stale identity, missing seal or receipt stops before calls', () => {
  const mutations = [b => delete b.exception, b => b.exception.expiresAt = '2026-10-29T00:00:00Z', b => b.reviewers.pop(), b => b.reviewers[1].sessionId = b.authors[0].sessionId, b => b.reviewers[1].model = 'gpt-6-luna', b => b.reviewers[0].sealedReports = false, b => delete b.receipt, b => b.receipt.signature = 'invalid', b => b.authors.push(author('sonnet'))];
  for (const mutate of mutations) {
    const b = sign(board()); mutate(b);
    const result = validateBoard(b);
    assert.equal(result.status, 'awaiting_approval', result.reason);
    assert.equal(result.owner, 'Roman'); assert.equal(result.callsAllowed, 0);
  }
  assert.equal(validateBoard({ ...sign(board()), verifyReceipt: undefined }).callsAllowed, 0);
});

test('Flora CLI rejects missing pool capture and skips semantic classification', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runPick } = await import('../bin/model-routing.mjs');
  const stateDir = mkdtempSync(join(tmpdir(), 'flora-cli-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const output = [];
  const deps = { policy: loadPolicy(), stateDir, env: { HOME: stateDir }, now: at, repoKey: () => 'srbryers/FLORA', loadOverride: () => null, loadLocalConfig: () => ({}), stdout: text => output.push(text), classify: () => assert.fail('No Jev call') };
  assert.equal(await runPick(['--kind', 'flora-ui-builder', '--no-quota', '--json'], deps), 4);
  assert.equal(JSON.parse(output.at(-1)).status, 'needs_pool_state');
  assert.equal(await runPick(['--brief', 'UI work', '--execute', '--no-quota', '--json'], deps), 3);
  assert.equal(JSON.parse(output.at(-1)).spawn, null);
});

test('Flora outcomes retain pool state and reject missing capture before recording or judging', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { logDecision } = await import('./state.mjs');
  const { recordOutcome } = await import('./outcomes.mjs');
  const stateDir = mkdtempSync(join(tmpdir(), 'flora-outcomes-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  logDecision(stateDir, decision(), 'brief');
  const outcome = await recordOutcome({ decisionId: 'decision-1', result: 'pass' }, { stateDir, now: at });
  assert.deepEqual(outcome.poolState, snapshot); assert.equal(outcome.costUsd, null);
  const broken = decision(); broken.id = 'broken'; delete broken.poolState;
  logDecision(stateDir, broken, 'brief');
  await assert.rejects(recordOutcome({ decisionId: 'broken', result: 'pass' }, { stateDir, now: at }), /Pool state/);
});

test('persisted Flora outcomes reach selection through the existing state log reader', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { logDecision, readStateLog } = await import('./state.mjs');
  const { recordOutcome } = await import('./outcomes.mjs');
  const stateDir = mkdtempSync(join(tmpdir(), 'flora-quality-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  for (const [route, result] of [['sonnet', 'pass'], ['sol', 'fail']]) {
    for (let i = 0; i < 3; i++) {
      const id = `${route}-${i}`;
      logDecision(stateDir, { ...decision(), id, route });
      await recordOutcome({ decisionId: id, result }, { stateDir, now: at });
    }
  }
  const selected = pick({ kind: 'flora-ui-builder', poolState: snapshot, availableRoutes: ['sonnet', 'sol'],
    headroomByDraw: { sonnet: 1, sol: 4 }, jobId: 'job', round: 1, boundary: 'dispatch' },
  { id: 'new', now: at, outcomes: readStateLog(stateDir, 'outcomes.jsonl').records });
  assert.equal(selected.route, 'sonnet');
  assert.equal(selected.quality.measuredDifference, true);
  assert.doesNotThrow(() => validateRoutingDecision(selected));
});

test('Flora Claude seats use latest aliases and preserve exact card identities', () => {
  for (const [role, route] of [['flora-designer', 'opus'], ['flora-ui-builder', 'sonnet'], ['flora-review-claude', 'sonnet'], ['flora-ui-elevation', 'sonnet']]) {
    assert.equal(profile.routes[route].model, route);
    assert.equal(profile.routes[route].cardIdentity, `anthropic/claude-${route}-5.5`);
    const d = pickFlora({ kind: role, poolState: snapshot, availableRoutes: [route], jobId: 'job', round: 1, boundary: 'dispatch' }, { id: 'decision', now: at });
    assert.equal(d.route, route);
    assert.equal(d.status, 'awaiting_scheduler');
    assert.equal(d.spawn, null);
  }
  assert.equal(validateFloraCards().cards, 11);
});
