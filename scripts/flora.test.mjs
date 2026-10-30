import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { profile, rolePolicy, hash, loadFloraCards, validateFloraCards, assertRoleRoute, selectFloraRoute, validateBoard, validateRoutingDecision, pickFlora } from './flora.mjs';
import { call } from './providers.mjs';
import { pick } from './pick.mjs';
import { loadPolicy, validatePolicy } from './policy.mjs';
const at = '2026-10-30T16:00:00.000Z';
const snapshot = JSON.parse(readFileSync(new URL('../policy/flora/pool-state.example.json', import.meta.url), 'utf8'));
const decision = () => ({ version: 1, id: 'decision-1', jobId: 'flora-385', at, round: 1, kind: 'flora-ui-builder', route: 'sol', previousRoute: null, boundary: 'dispatch', reason: 'equal quality record; Sol first', basis: 'policy', selection_basis: 'approved_profile', policyHash: hash(rolePolicy), profileHash: hash(profile), poolState: structuredClone(snapshot) });

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
