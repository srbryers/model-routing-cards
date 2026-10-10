import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, logDecision } from './state.mjs';
import { validatePolicy } from './policy.mjs';
import { loadPolicyWithTestRepos } from './fixtures/with-test-repos.mjs';
import { pick, quotaPace } from './pick.mjs';
import { normalizeQuota, readQuota, buildSpawn, buildApproval } from './adapters/bb.mjs';
const policy = loadPolicyWithTestRepos();
const now = '2026-10-04T15:35:00Z';
const sample = JSON.parse(readFileSync(new URL('./fixtures/quota.json', import.meta.url), 'utf8'));
const quota = normalizeQuota(sample);
const choose = (input = {}, deps = {}) => pick({ kind: 'multi-step-coding', ...input }, { policy, now, quota, id: 'dec_test', localConfig: { routes: { 'pi-local': { model: 'local-test-model' } } }, ...deps });
function changed(claude = 59, codex = 19, weekly = 33) {
  const q = structuredClone(quota);
  q.claude.windows[0].usedPercent = claude; q.codex.windows[0].usedPercent = codex; q.claude.windows[1].usedPercent = weekly;
  return q;
}
function card(trust = 'CALIBRATED', recommend = 'anthropic/claude-sonnet-5.5', generated = '2026-10-04') {
  return { task: 'implementation', trust, recommend, generated, models: [
    { model: 'anthropic/claude-sonnet-5.5', cost_per_accepted_usd: 0.01, cost_source: 'reported' },
    { model: 'openai/gpt-6-astra', cost_per_accepted_usd: 0.02, cost_source: 'reported' },
    { model: 'openai/gpt-6.1-sol', cost_per_accepted_usd: 0.03, cost_source: 'reported' },
  ] };
}
const override = route => ({ policyVersion: 1, rules: [{ kinds: ['*'], route, source: 'fixture', why: 'repo preference' }] });

test('quota adapter strips account metadata and invokes only local usage command', () => {
  assert.deepEqual(readQuota({ execFile: (file, argv) => { assert.equal(file, 'bb'); assert.deepEqual(argv, ['settings', 'usage', '--json']); return JSON.stringify(sample); } }), quota);
  assert.deepEqual(Object.keys(quota).sort(), ['claude', 'codex']);
  assert.deepEqual(Object.keys(quota.claude.windows[0]), ['kind', 'usedPercent', 'resetsAt']);
  assert.equal(readQuota({ execFile: () => { throw Error('account detail'); } }), null);
  assert.equal(normalizeQuota({ codex: { status: 'error', windows: sample.codex.windows } }), null);
});
test('corrected sample is a pace tie, with +9.0 and +5.6 headroom', () => {
  const d = choose(); assert.equal(d.basis, 'trial'); assert.equal(d.route, 'sonnet');
  assert.ok(Math.abs(d.quota.claude.weekly.headroom - 9.01) < 0.02);
  assert.ok(Math.abs(d.quota.codex.weekly.headroom - 5.57) < 0.02);
  assert.equal(choose({}, { alternation: { 'multi-step-coding': 'sonnet' } }).route, 'astra');
});
for (const used of [20, 25]) test(`pace prefers Sonnet at Claude ${used}% over Codex 19%`, () => {
  const d = choose({}, { quota: changed(59, 19, used) });
  assert.equal(d.route, 'sonnet'); assert.equal(d.basis, 'policy');
  assert.match(d.why.join(' '), /sonnet weekly headroom .*astra weekly headroom/);
});
test('PC uses the same pace rule; missing quota is explicitly an unknown trial', () => {
  assert.equal(choose({ machine: 'pc' }, { quota: changed(59, 19, 20) }).route, 'sonnet');
  const d = choose({}, { quota: null }); assert.equal(d.quota, 'unknown'); assert.equal(d.basis, 'trial');
});
test('soft thresholds are strict and conflicting preferences fall back to pace', () => {
  assert.equal(choose({}, { quota: changed(70, 85, 20) }).route, 'sonnet');
  assert.equal(choose({}, { quota: changed(70.01) }).route, 'astra');
  assert.equal(choose({}, { quota: changed(59, 85.01) }).route, 'sonnet');
  const d = choose({}, { quota: changed(71, 86) }); assert.equal(d.status, 'ok');
  assert.equal(d.route, 'sonnet'); assert.equal(d.basis, 'policy');
  assert.match(d.notes.join(' '), /conflicting quota preferences ignored/);
});
test('Claude over 80% is reserved for tier 3 or main threads', () => {
  assert.equal(choose({ kind: 'architecture' }, { quota: changed(81) }).route, 'opus');
  assert.equal(choose({ kind: 'architecture', mainThread: true }, { quota: changed(81) }).route, 'opus');
  assert.equal(choose({ kind: 'quick-edit' }, { override: override('sonnet'), quota: changed(81) }).route, 'muse');
  assert.equal(choose({ kind: 'quick-edit', mainThread: true }, { override: override('sonnet'), quota: changed(81) }).route, 'sonnet');
  assert.equal(choose({ kind: 'quick-edit' }, { override: override('sonnet'), quota: changed(80) }).route, 'sonnet');
});
test('blocked repo preference is explained and falls back', () => {
  const d = choose({}, { override: override('sonnet'), quota: changed(81, 86) });
  assert.equal(d.route, 'astra'); assert.match(d.why.join(' '), /repo override blocked/);
});
test('repo rules, machine restrictions, external instructions and notes survive', () => {
  assert.equal(choose({ kind: '3d-work' }, { repo: 'acme/studio-3d' }).route, 'astra');
  const game = choose({ kind: 'quick-edit' }, { repo: 'acme/game-app' });
  assert.equal(game.machine, 'pc'); assert.equal(game.route, 'luna');
  assert.ok(game.alternatives.some(a => a.route === 'muse'));
  assert.equal(choose({ kind: 'data-contract' }, { repo: 'acme/data-app' }).route, 'astra');
  const external = choose({ kind: 'user-facing-copy' }, { repo: 'acme/coach-app' });
  assert.equal(external.status, 'external'); assert.equal(external.requiresSpendApproval, true);
  assert.ok(external.instruction); assert.equal(buildSpawn(external, {}), undefined);
  assert.match(external.notes.join(' '), /author never approves/);
  for (const kind of Object.keys(policy.kinds)) assert.notEqual(choose({ kind }, { repo: 'acme/kit-lib' }).route, 'muse');
});
test('two failures moves up one tier and skips an escalated repo route', () => {
  const d = choose({ kind: 'quick-edit', failures: 2 }); assert.ok(['sonnet', 'astra'].includes(d.route));
  const repo = choose({ kind: 'quick-edit', failures: 2 }, { repo: 'acme/coach-app' });
  assert.notEqual(repo.route, 'terra'); assert.match(repo.why.join(' '), /escalated repo route skipped/);
});
test('review excludes author vendor, including a repo override', () => {
  for (const kind of policy.review.kinds) {
    const d = choose({ kind, author: 'astra' }, { repo: 'acme/studio-3d' });
    assert.ok(!['astra', 'luna', 'sol'].includes(d.route));
  }
  const d = choose({ kind: 'high-risk-review', author: 'anthropic' });
  assert.equal(d.route, 'sol-review');
});
test('review fallback still respects exclusions, machine, quota and cooldown', () => {
  const d = choose({ kind: 'high-risk-review', author: 'anthropic', machine: 'pc' }, { limits: { astra: '2026-10-05', luna: '2026-10-05', sol: '2026-10-05', 'sol-review': '2026-10-05' } });
  assert.equal(d.status, 'blocked');
  // Sol runs on the PC, so with Astra and Luna limited it is the review fallback.
  assert.equal(choose({ kind: 'high-risk-review', author: 'anthropic', machine: 'pc' }, { limits: { astra: '2026-10-05', luna: '2026-10-05', 'sol-review': '2026-10-05' } }).route, 'sol');
});
test('fresh calibrated card can choose only an allowed route', () => {
  const d = choose({}, { cards: { 'multi-step-coding': card() }, alternation: { 'multi-step-coding': 'sonnet' } });
  assert.equal(d.route, 'sonnet'); assert.equal(d.basis, 'card');
  const blocked = choose({}, { quota: changed(81), cards: { 'multi-step-coding': card() } });
  assert.equal(blocked.route, 'astra'); assert.match(blocked.why.join(' '), /winner not allowed/);
});
for (const [trust, date] of [['CALIBRATED', '2026-09-01'], ['UNCALIBRATED', '2026-10-04'], ['SINGLE_CANDIDATE', '2026-10-04']]) test(`${trust} dated ${date} is ignored`, () => {
  const d = choose({}, { cards: { 'multi-step-coding': card(trust, undefined, date) } });
  assert.equal(d.basis, 'trial'); assert.match(d.why.join(' '), /ignored/);
});
test('card cheaper only within tie, with measured comparable costs', () => {
  const c = card('NO_CLEAR_WINNER');
  assert.equal(choose({}, { cards: { 'multi-step-coding': c } }).basis, 'card-cheaper');
  assert.equal(choose({}, { quota: changed(59, 19, 20), cards: { 'multi-step-coding': c } }).basis, 'policy');
  c.models[1].cost_per_accepted_usd = null;
  assert.equal(choose({}, { cards: { 'multi-step-coding': c } }).basis, 'trial');
});
test('Muse cooldown uses Luna until expiry; exhaustion offers metered while bulk stays local', () => {
  const limits = { muse: '2026-10-04T16:00:00Z' };
  assert.equal(choose({ kind: 'quick-edit' }, { limits }).route, 'luna');
  assert.equal(choose({ kind: 'quick-edit' }, { limits, now: '2026-10-04T16:00:00Z' }).route, 'muse');
  limits.luna = limits.muse;
  assert.equal(choose({ kind: 'quick-edit' }, { limits }).status, 'needs_approval');
  assert.equal(choose({ kind: 'bulk-text' }, { limits, quota: changed(99, 99) }).route, 'pi-local');
});
test('pure pick does not mutate input, quota, cards or state', () => {
  const deps = { policy, now, quota, cards: { 'multi-step-coding': card() }, alternation: {}, limits: {} };
  const before = structuredClone(deps); pick({ kind: 'multi-step-coding' }, deps); assert.deepEqual(deps, before);
});
test('spawn omits missing values, keeps exact argument boundaries', () => {
  const spawn = buildSpawn(choose(), { title: 'title with spaces' });
  assert.deepEqual(spawn.missing, ['project', 'section', 'prompt-file']);
  assert.ok(!spawn.argv.includes('--project')); assert.ok(spawn.argv.includes('title with spaces'));
  assert.deepEqual(spawn.argv.slice(0, 3), ['bb', 'thread', 'spawn']);
});
test('policy validates classifier, margin, card path and unique model aliases', () => {
  for (const mutate of [p => p.classifier.minProbability = -1, p => p.classifier.minMargin = 2,
    p => p.tieBreak.marginPoints = -1, p => p.cards.byKind.docs = '../escape.json',
    p => p.routes.luna.cardModels = p.routes.muse.cardModels]) {
    const p = structuredClone(policy); mutate(p); assert.equal(validatePolicy(p).ok, false);
  }
});

test('tier 3 escalated repo routes are skipped without inventing a fourth tier', () => {
  const d = choose({ kind: 'data-contract', failures: 2 }, { repo: 'acme/data-app' });
  assert.equal(d.route, 'opus'); assert.match(d.why.join(' '), /escalated repo route skipped/);
});
test('central plus file exclusions can block a kind and retain all explanations', () => {
  const file = { policyVersion: 1, rules: [{ kinds: ['*'], excludeRoutes: ['luna'], source: 'fixture', why: 'test constraint' }] };
  const d = choose({ kind: 'quick-edit' }, { repo: 'acme/kit-lib', override: file });
  assert.equal(d.status, 'blocked');
  assert.ok(d.alternatives.some(a => a.route === 'muse' && /excluded/.test(a.rejected)));
  assert.ok(d.alternatives.some(a => a.route === 'luna' && /excluded/.test(a.rejected)));
  assert.match(d.notes.join(' '), /kit-curator/);
});
test('expired quota is unknown and does not impose an old hard stop', () => {
  const d = choose({}, { now: '2026-10-11T00:00:00Z', quota: changed(99, 99) });
  assert.equal(d.status, 'ok'); assert.equal(d.quota, 'unknown'); assert.equal(d.basis, 'trial');
});
test('card cannot bypass an external instruction; malformed costs and future cards are ignored', () => {
  const p = structuredClone(policy); p.cards.byKind['user-facing-copy'] = 'quick-edit.card.json';
  const d = choose({ kind: 'user-facing-copy' }, { policy: p, repo: 'acme/coach-app',
    cards: { 'user-facing-copy': card('CALIBRATED', 'meta/muse-spark-1.3') } });
  assert.equal(d.status, 'external');
  const c = card('NO_CLEAR_WINNER'); c.models = {};
  assert.equal(choose({}, { cards: { 'multi-step-coding': c } }).basis, 'trial');
  assert.equal(choose({}, { cards: { 'multi-step-coding': card('CALIBRATED', undefined, '2027-01-01') } }).basis, 'trial');
});

test('pool quota ignores Fable and keeps the highest duplicate weekly usage', () => {
  const raw = structuredClone(sample);
  raw['claude-code'].windows[1].usedPercent = 34;
  raw['claude-code'].windows.push({ label: 'Fable', kind: 'weekly', model: 'fable', usedPercent: 2,
    resetsAt: '2026-10-08T17:00:00.495Z' });
  assert.equal(choose({}, { quota: normalizeQuota(raw) }).quota.claude.weekly.used, 34);
  raw['claude-code'].windows.push({ kind: 'weekly', usedPercent: 37, resetsAt: '2026-10-08T17:00:00.495Z' },
    { kind: 'weekly', usedPercent: 10, resetsAt: '2026-10-08T17:00:00.495Z' });
  const normalized = normalizeQuota(raw);
  assert.equal(normalized.claude.windows.filter(w => w.kind === 'weekly').length, 1);
  assert.equal(choose({}, { quota: normalized }).quota.claude.weekly.used, 37);
  assert.equal(quotaPace({ claude: { windows: raw['claude-code'].windows } }, Date.parse(now)).claude.weekly.used, 37);
});
test('quota requires time zones and clamps elapsed percentage', () => {
  const q = changed(); q.claude.windows[1].resetsAt = '2026-10-08T17:00:00';
  const d = choose({}, { quota: q });
  assert.equal(d.quota.claude.weekly, undefined);
  assert.ok(d.notes.includes('quota unknown: hard stops not applied'));
  assert.equal(d.quota.claude['five-hour'].elapsed, 0);
  const raw = structuredClone(sample); raw.codex.windows[0].resetsAt = '2026-10-08T17:00:00';
  assert.equal(normalizeQuota(raw).codex, undefined);
  q.claude.windows[1].resetsAt += '+00:00';
  assert.ok(choose({}, { quota: q }).quota.claude.weekly);
});
test('require-quota blocks unknown candidate pools and accepts complete quota', () => {
  assert.equal(choose({ requireQuota: true }).status, 'ok');
  for (const q of [null, { codex: quota.codex }, { ...quota, claude: { windows: [quota.claude.windows[1]] } }]) {
    const d = choose({ requireQuota: true }, { quota: q });
    assert.equal(d.status, 'blocked'); assert.match(d.why.join(' '), /quota unknown: hard stops not applied/);
  }
  assert.equal(choose({ requireQuota: true }, { now: '2026-11-01', quota }).status, 'blocked');
  // Muse has no readable quota, while a free local route and an external instruction need no worker quota.
  assert.equal(choose({ kind: 'quick-edit', requireQuota: true }).route, 'muse');
  assert.equal(choose({ kind: 'user-facing-copy', requireQuota: true }, { repo: 'acme/coach-app', quota: null }).status, 'external');
});
test('repo and file rules outrank calibrated cards', () => {
  for (const deps of [{ repo: 'acme/coach-app' }, { override: override('gpt-5.5') }]) {
    const d = choose({}, { ...deps, cards: { 'multi-step-coding': card() } });
    assert.equal(d.route, 'gpt-5.5'); assert.equal(d.basis, 'policy');
    assert.ok(d.why.includes('repo rule outranks card'));
  }
});
test('cards cannot apply to another task', () => {
  const c = card(); c.task = 'quick-edit';
  const d = choose({}, { cards: { 'multi-step-coding': c } });
  assert.equal(d.basis, 'trial'); assert.match(d.why.join(' '), /task mismatch/);
});
test('default machine comes from validated policy and respects repo machines', () => {
  const p = structuredClone(policy); p.machines.default = 'pc';
  assert.equal(choose({ kind: 'quick-edit' }, { policy: p }).machine, 'pc');
  assert.equal(choose({ kind: 'quick-edit' }, { policy: p, override: { policyVersion: 1, rules: [], machines: ['mac-studio'] } }).machine, 'mac-studio');
  for (const value of ['default', 'unknown', null]) { p.machines.default = value; assert.equal(validatePolicy(p).ok, false); }
});

test('a lone Claude threshold excludes a calibrated Sonnet card', () => {
  const d = choose({}, { quota: changed(75), cards: { 'multi-step-coding': card() } });
  assert.equal(d.route, 'astra'); assert.equal(d.basis, 'trial');
  assert.match(d.why.join(' '), /card implementation CALIBRATED, winner not allowed, ignored/);
});
test('a lone Claude threshold blocks a tier-2 repo or file rule before selection', () => {
  for (const source of ['repo', 'file']) {
    const p = structuredClone(policy);
    const rules = override('sonnet');
    p.repos['test/project'] = { rules: rules.rules };
    const d = choose({}, { policy: p, quota: changed(75),
      ...(source === 'repo' ? { repo: 'test/project' } : { override: rules }) });
    assert.equal(d.route, 'astra');
    assert.ok(d.alternatives.some(a => a.route === 'sonnet'
      && a.rejected === 'repo rule on sonnet blocked by quota: Claude 5h 75% > 70%'));
  }
});
test('a lone Codex threshold blocks the studio Astra rule and chooses Sonnet', () => {
  const d = choose({ kind: '3d-work' }, { repo: 'acme/studio-3d', quota: changed(59, 90) });
  assert.equal(d.route, 'sonnet'); assert.equal(d.basis, 'policy');
  assert.ok(d.alternatives.some(a => a.route === 'astra'
    && a.rejected === 'repo rule on astra blocked by quota: Codex weekly 90% > 85%'));
});
test('a lone preference falls back when its target pool is limited or excluded', () => {
  const excluded = { policyVersion: 1, rules: [{ kinds: ['multi-step-coding'], excludeRoutes: ['astra', 'sol'], source: 'fixture', why: 'unavailable' }] };
  for (const constraint of [{ limits: { astra: '2026-10-05', sol: '2026-10-05' } }, { override: excluded }]) {
    const d = choose({}, { quota: changed(75), ...constraint });
    assert.equal(d.route, 'sonnet'); assert.equal(d.basis, 'policy');
    assert.ok(d.notes.some(n => /no allowed codex candidate, falling back to claude/.test(n)));
  }
  const reverse = choose({}, { quota: changed(59, 90), limits: { sonnet: '2026-10-05' } });
  assert.equal(reverse.route, 'astra'); assert.match(reverse.notes.join(' '), /falling back to codex/);
});
test('cooldowns on every subscription route offer metered; the 80 percent reserve alone never does', () => {
  const d = choose({}, { quota: changed(75), limits: { astra: '2026-10-05', sol: '2026-10-05', sonnet: '2026-10-05' } });
  assert.equal(d.status, 'needs_approval'); assert.equal(d.route, 'fw-kimi-k3');
  // Sonnet is reserved, Astra and Sol are on cooldown: held back by the reserve, so the user decides.
  const held = choose({}, { quota: changed(81), limits: { astra: '2026-10-05', sol: '2026-10-05' } });
  assert.equal(held.status, 'blocked'); assert.equal(held.route, undefined);
  assert.match(held.why.join(' '), /held back only by the Claude reserve.*metered not offered/);
});
test('strict quota allows unreadable Muse and configured Pi, relying on cooldowns', () => {
  for (const [kind, route, pool] of [['quick-edit', 'muse', 'muse'], ['bulk-text', 'pi-local', 'local']]) {
    const d = choose({ kind, requireQuota: true });
    assert.equal(d.status, 'ok'); assert.equal(d.route, route);
    assert.ok(d.why.includes(`${pool} quota unreadable by design; relying on cooldowns`));
  }
  const limited = choose({ kind: 'bulk-text', requireQuota: true }, { limits: { 'pi-local': '2026-10-05' } });
  assert.equal(limited.route, 'muse');
  assert.equal(choose({ requireQuota: true }, { quota: { codex: quota.codex } }).status, 'blocked');
});
test('Pi prerequisites are explicit and null reasoning is not a missing argument', () => {
  const d = choose({ kind: 'bulk-text' });
  assert.deepEqual(d.beforeSpawn, ['Check the local server is running: `curl -s -m 3 127.0.0.1:8080/v1/models`']);
  const spawn = buildSpawn(d, {});
  assert.equal(spawn.argv.includes('--reasoning-level'), false);
  assert.equal(spawn.missing.includes('reasoning-level'), false);
  assert.ok(buildSpawn({ ...d, reasoning: undefined }, {}).missing.includes('reasoning-level'));
});
test('repo review gates remain in notes rather than beforeSpawn', () => {
  const d = choose({}, { repo: 'acme/coach-app' });
  assert.match(d.notes.join(' '), /Independent review of every implementation/);
  assert.deepEqual(d.beforeSpawn, []);
});
test('missing Pi configuration drops the route and uses policy fallbacks', () => {
  const d = choose({ kind: 'bulk-text' }, { localConfig: null });
  assert.equal(d.route, 'muse'); assert.deepEqual(d.beforeSpawn, []);
  assert.ok(d.alternatives.some(a => a.route === 'pi-local' && a.rejected === 'pi-local model not configured in local.json'));
});
test('four or more task failures choose Opus xhigh rather than restarting tier 2', () => {
  for (const failures of [4, 9]) {
    const d = choose({ kind: 'quick-edit', failures });
    assert.equal(d.route, 'opus'); assert.equal(d.reasoning, 'xhigh');
  }
});

test('tier-1 exhausted subscriptions offer the first unmeasured metered route, with approval required', () => {
  const limits = { muse: '2026-10-05', luna: '2026-10-05' };
  const d = choose({ kind: 'quick-edit' }, { limits });
  assert.equal(d.route, 'fw-deepseek-v4p1-flash'); assert.equal(d.status, 'needs_approval');
  assert.equal(d.requiresSpendApproval, true); assert.equal(d.spendApproved, false);
  assert.deepEqual(d.costPer1M, { in: 0.3, out: 1.2 });
  assert.match(d.why.join(' '), /order is unmeasured; no card backs it/);
  assert.ok(d.notes.includes("mac-studio only: BB's Pi extension does not start on Windows."));
  assert.equal(buildSpawn(d, {}), undefined); assert.equal(d.spawn, null);
  assert.ok(buildApproval(d, {}).spawnArgv.includes(d.model));
  assert.equal(d.reasoning, 'high');
  const approved = choose({ kind: 'quick-edit', approvedRoutes: ['fw-deepseek-v4p1-flash'] }, { limits });
  assert.equal(approved.route, d.route); assert.equal(approved.status, 'ok'); assert.equal(approved.spendApproved, true);
  assert.equal(choose({ kind: 'quick-edit' }, { limits: { muse: '2026-10-05' } }).route, 'luna');
});
test('tier 3 uses GPT when Claude is limited; paid fallbacks honor their own cooldowns', () => {
  const d = choose({ kind: 'architecture' }, { limits: { opus: '2026-10-05' } });
  assert.equal(d.route, 'astra');
  const limits = { muse: '2026-10-05', luna: '2026-10-05', 'fw-deepseek-v4p1-flash': '2026-10-05' };
  assert.equal(choose({ kind: 'quick-edit' }, { limits }).route, 'fw-minimax-m3');
  limits['fw-minimax-m3'] = '2026-10-05';
  assert.equal(choose({ kind: 'quick-edit' }, { limits }).status, 'blocked');
});
test('exclusions, machines and review independence cannot unlock metered spending', () => {
  const limits = { muse: '2026-10-05', luna: '2026-10-05' };
  for (const [input, deps] of [
    [{ kind: 'quick-edit', machine: 'pc' }, {}],
    [{ kind: 'quick-edit' }, { repo: 'acme/kit-lib' }],
    [{ kind: 'first-pass-review', author: 'openai' }, {}],
    [{ kind: 'quick-edit', failures: 2 }, { override: { policyVersion: 1, rules: [{ kinds: ['quick-edit'], route: 'muse', source: 'fixture', why: 'preferred' }] }, limits: { sonnet: '2026-10-05', astra: '2026-10-05', sol: '2026-10-05' } }],
  ]) assert.equal(choose(input, { limits, ...deps }).status, 'blocked');
  assert.equal(choose({ kind: 'bulk-text' }, { limits, localConfig: null }).status, 'blocked');
});
test('explicit metered repo/file routes require approval; disabled OpenRouter routes fall back', () => {
  for (const key of ['override', 'repo']) {
    const p = structuredClone(policy); p.repos['test/metered'] = { rules: override('fw-kimi-k3').rules };
    const d = choose({}, { policy: p, ...(key === 'override' ? { override: override('fw-kimi-k3') } : { repo: 'test/metered' }) });
    assert.equal(d.route, 'fw-kimi-k3'); assert.equal(d.status, 'needs_approval');
    assert.deepEqual(d.costPer1M, { in: null, out: null });
  }
  for (const route of ['or-gemini-flash', 'or-gemini-pro']) {
    const d = choose({ approvedRoutes: [route] }, { override: override(route) });
    assert.notEqual(d.route, route);
    assert.ok(d.alternatives.some(a => a.route === route && a.rejected === policy.routes[route].disabled));
  }
  const external = choose({ kind: 'user-facing-copy', approvedRoutes: ['gemini-copy'] }, { repo: 'acme/coach-app' });
  assert.equal(external.status, 'external'); assert.equal(external.requiresSpendApproval, true);
});
test('a metered OpenAI model cannot review OpenAI-authored work', () => {
  const d = choose({ kind: 'routine-review', author: 'astra' }, { override: override('fw-gpt-oss-120b') });
  assert.equal(d.route, 'sonnet');
  assert.ok(d.alternatives.some(a => a.route === 'fw-gpt-oss-120b' && /different vendor/.test(a.rejected)));
});

test('strict quota checks selected and deciding pools, not unused fallbacks', () => {
  assert.equal(choose({ kind: 'quick-edit', requireQuota: true }, { quota: { claude: quota.claude } }).route, 'muse');
  assert.equal(choose({ kind: 'bulk-text', requireQuota: true }, { quota: null }).route, 'pi-local');
  const selectedCodex = choose({ kind: 'quick-edit', requireQuota: true }, { quota: null, limits: { muse: '2026-10-05' } });
  assert.equal(selectedCodex.status, 'blocked');
  assert.match(selectedCodex.why.join(' '), /required quota missing for codex/);
  assert.equal(choose({ requireQuota: true }, { quota: { codex: quota.codex } }).status, 'blocked');
  assert.equal(choose({ requireQuota: true }, { quota: { codex: quota.codex }, override: override('astra') }).route, 'astra');
  const explicitPaid = choose({ requireQuota: true }, { quota: { claude: changed(75).claude }, override: override('fw-kimi-k3') });
  assert.equal(explicitPaid.status, 'needs_approval');
  const preference = choose({ requireQuota: true }, { quota: { codex: changed(59, 90).codex } });
  assert.equal(preference.status, 'blocked');
  assert.match(preference.why.join(' '), /required quota missing for claude/);
});
test('disabled repo/file routes and cloud bulk fallbacks get prominent notes', () => {
  for (const deps of [{ override: override('or-gemini-flash') }, {
    policy: { ...policy, repos: { 'test/disabled': { rules: override('or-gemini-flash').rules } } }, repo: 'test/disabled',
  }]) {
    const d = choose({}, deps);
    assert.ok(d.notes.includes(`repo rule names or-gemini-flash, which is disabled: ${policy.routes['or-gemini-flash'].disabled}`));
  }
  for (const deps of [{ localConfig: null }, { limits: { 'pi-local': '2026-10-05' } }]) {
    const d = choose({ kind: 'bulk-text' }, deps);
    assert.equal(d.status, 'ok'); assert.equal(d.route, 'muse');
    assert.ok(d.notes.includes('pi-local unavailable; falling back to muse (cloud). Do not send private text.'));
  }
  assert.ok(!choose({ kind: 'bulk-text' }).notes.some(note => note.includes('Do not send private text')));
});

// --- Sol: tier 2 is Sonnet, Astra or Sol. Pace chooses a pool; the pool chooses a route. ---
const mkdir = () => mkdtempSync(join(tmpdir(), 'pick-sol-'));
/** Consecutive picks through the real decision log, so alternation state is what the CLI would read. */
function sequence(t, count, input = {}, deps = {}) {
  const dir = mkdir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const picks = [];
  for (let i = 0; i < count; i++) {
    const d = choose(input, { ...readState(dir, policy), ...deps });
    logDecision(dir, d); picks.push(d);
  }
  return picks;
}
const routes = picks => picks.map(d => d.route);
const bases = picks => picks.map(d => d.basis);
const codexWins = () => changed(59, 19, 60);

test('Sol: codex wins pace, so Astra and Sol alternate as trials', t => {
  const picks = sequence(t, 4, {}, { quota: codexWins() });
  assert.deepEqual(routes(picks), ['astra', 'sol', 'astra', 'sol']);
  assert.deepEqual(bases(picks), ['trial', 'trial', 'trial', 'trial']);
  assert.match(picks[0].why.join(' '), /codex pool leads by pace/);
  assert.ok(picks[1].alternatives.some(a => a.route === 'sonnet'));
});
test('Sol: alternation is per kind', t => {
  const [a, b] = sequence(t, 2, {}, { quota: codexWins() });
  const dir = mkdir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  logDecision(dir, a); logDecision(dir, b);
  assert.equal(choose({ kind: 'migration' }, { quota: codexWins(), ...readState(dir, policy) }).route, 'astra');
});
test('Sol: a codex-pool turn survives a Sonnet trial in between', () => {
  const k = 'multi-step-coding';
  const d = choose({}, { quota: codexWins(), alternation: { [k]: 'sonnet' }, poolAlternation: { [k]: { claude: 'sonnet', codex: 'astra' } } });
  assert.equal(d.route, 'sol'); assert.equal(d.basis, 'trial');
  // Without per-pool state, a caller that passes only `alternation` still gets a valid rotation.
  assert.equal(choose({}, { quota: codexWins(), alternation: { [k]: 'sol' } }).route, 'astra');
  assert.equal(choose({}, { quota: codexWins(), alternation: { [k]: 'sonnet' } }).route, 'astra');
});
test('Sol: a pool tie rotates Sonnet, Astra, Sol, Sonnet as trials', t => {
  const picks = sequence(t, 4);
  assert.deepEqual(routes(picks), ['sonnet', 'astra', 'sol', 'sonnet']);
  assert.deepEqual(bases(picks), ['trial', 'trial', 'trial', 'trial']);
  assert.match(picks[0].why.join(' '), /alternate sonnet\/astra\/sol/);
  assert.deepEqual(routes(sequence(t, 3, {}, { quota: null })), ['sonnet', 'astra', 'sol']);
});
test('Sol: claude wins pace, so Sonnet by policy and no trial', t => {
  for (const d of sequence(t, 3, {}, { quota: changed(59, 19, 20) })) {
    assert.equal(d.route, 'sonnet'); assert.equal(d.basis, 'policy');
  }
});
test('Sol: Claude 5h at 75% sends tier 2 to the codex pool, then Astra/Sol alternate', t => {
  const picks = sequence(t, 4, {}, { quota: changed(75) });
  assert.deepEqual(routes(picks), ['astra', 'sol', 'astra', 'sol']);
  assert.ok(picks.every(d => d.basis === 'trial'));
  assert.ok(picks[0].alternatives.some(a => a.route === 'sonnet' && /blocked by quota: Claude 5h 75% > 70%/.test(a.rejected)));
});
test('Sol: codex weekly at 90% removes Astra and Sol, leaving Sonnet', t => {
  for (const d of sequence(t, 3, {}, { quota: changed(59, 90) })) {
    assert.equal(d.route, 'sonnet'); assert.equal(d.basis, 'policy');
    for (const route of ['astra', 'sol']) assert.ok(d.alternatives.some(a => a.route === route && /Codex weekly 90% > 85%/.test(a.rejected)));
  }
});
test('Sol: one limited route leaves the other codex route; a limited pool leaves Sonnet', t => {
  const picks = sequence(t, 3, {}, { quota: codexWins(), limits: { sol: '2026-10-05' } });
  assert.deepEqual(routes(picks), ['astra', 'astra', 'astra']); assert.deepEqual(bases(picks), ['policy', 'policy', 'policy']);
  assert.deepEqual(routes(sequence(t, 3, {}, { limits: { astra: '2026-10-05' } })), ['sonnet', 'sol', 'sonnet']);
});
test('Sol: on the PC it rotates and alternates the same as on the Mac Studio', t => {
  assert.deepEqual(routes(sequence(t, 4, { machine: 'pc' })), ['sonnet', 'astra', 'sol', 'sonnet']);
  assert.deepEqual(routes(sequence(t, 4, { machine: 'pc' }, { quota: codexWins() })), ['astra', 'sol', 'astra', 'sol']);
  // A repo that only runs on the PC gets the same result without a --machine flag.
  assert.ok(routes(sequence(t, 4, { kind: 'multi-step-coding' }, { repo: 'acme/game-app' })).includes('sol'));
});
test('Sol: every tier-2 kind can return Sol on the PC', () => {
  const kinds = Object.entries(policy.kinds).filter(([, k]) => k.tier === 2).map(([id]) => id);
  assert.ok(kinds.length > 0);
  for (const kind of kinds) {
    const d = choose({ kind, machine: 'pc' }, { quota: codexWins(), alternation: { [kind]: 'astra' } });
    assert.equal(d.route, 'sol', kind); assert.equal(d.status, 'ok', kind);
  }
});
// ⚠ BB's Pi extension fails on Windows ("Unsupported fd type: UNKNOWN"); no Pi route may be picked on the PC.
test('pick --machine pc never returns a Pi route, for any kind', () => {
  const pi = new Set(Object.entries(policy.routes).filter(([, r]) => r.provider === 'pi').map(([id]) => id));
  assert.ok(pi.has('pi-local') && pi.has('fw-kimi-k3'));
  const everyLimited = Object.fromEntries(Object.entries(policy.routes).filter(([, r]) => r.pool !== 'metered').map(([id]) => [id, '2026-10-05']));
  const approved = [...pi];
  for (const kind of Object.keys(policy.kinds)) {
    for (const deps of [{}, { quota: codexWins() }, { quota: null }, { limits: everyLimited }]) {
      for (const input of [{}, { approvedRoutes: approved }]) {
        const d = choose({ kind, machine: 'pc', ...input }, deps);
        assert.ok(!pi.has(d.route), `${kind}: ${d.route}`);
      }
    }
  }
  const bulk = choose({ kind: 'bulk-text', machine: 'pc' });
  assert.notEqual(bulk.route, 'pi-local');
  assert.ok(bulk.alternatives.some(a => a.route === 'pi-local' && /machine limit/.test(a.rejected)));
});
test('pc metered fallback with every subscription route on cooldown is blocked, not a Pi route', () => {
  const limits = Object.fromEntries(Object.entries(policy.routes).filter(([, r]) => r.pool !== 'metered').map(([id]) => [id, '2026-10-05']));
  const approvedRoutes = Object.keys(policy.routes).filter(id => policy.routes[id].pool === 'metered');
  for (const kind of ['quick-edit', 'multi-step-coding', 'bulk-text']) {
    const d = choose({ kind, machine: 'pc', approvedRoutes }, { limits });
    assert.equal(d.status, 'blocked', kind); assert.equal(d.route, undefined, kind);
  }
  assert.ok(choose({ kind: 'multi-step-coding', machine: 'pc' }, { limits }).alternatives.some(a => a.route === 'fw-kimi-k3' && /machine limit/.test(a.rejected)));
  // The same cooldowns on the Mac Studio do reach a metered Pi route.
  assert.equal(choose({ kind: 'quick-edit', machine: 'mac-studio' }, { limits }).route, 'fw-deepseek-v4p1-flash');
});
test('Sol: a repo rule naming Astra stays on Astra', t => {
  for (const d of sequence(t, 3, { kind: '3d-work' }, { repo: 'acme/studio-3d' })) {
    assert.equal(d.route, 'astra'); assert.equal(d.basis, 'policy');
    assert.ok(d.alternatives.some(a => a.route === 'sol'));
  }
  for (const d of sequence(t, 3, { kind: 'data-contract' }, { repo: 'acme/data-app' })) assert.equal(d.route, 'astra');
});
test('Sol: review keeps a different vendor from the author, in both directions', () => {
  for (const author of ['astra', 'sol', 'openai']) {
    const d = choose({ kind: 'routine-review', author }, { quota: codexWins() });
    assert.equal(d.route, 'sonnet');
    for (const route of ['astra', 'sol']) assert.ok(d.alternatives.some(a => a.route === route && /different vendor/.test(a.rejected)));
  }
  for (const kind of policy.review.kinds) for (const author of ['astra', 'sol']) {
    assert.ok(!['astra', 'sol', 'luna'].includes(choose({ kind, author }).route), `${kind} ${author}`);
  }
  assert.ok(['astra', 'sol'].includes(choose({ kind: 'routine-review', author: 'sonnet' }, { quota: codexWins() }).route));
});
test('Sol: its note and supported reasoning reach the decision', () => {
  const d = choose({}, { quota: codexWins(), alternation: { 'multi-step-coding': 'astra' } });
  assert.equal(d.route, 'sol'); assert.equal(d.model, 'gpt-6.1-sol'); assert.equal(d.reasoning, 'high');
  assert.match(d.notes.join(' '), /Codex CLI 0\.160 or later/);
  assert.deepEqual(buildSpawn(d, {}).argv.slice(buildSpawn(d, {}).argv.indexOf('--provider'), buildSpawn(d, {}).argv.indexOf('--provider') + 4), ['--provider', 'codex', '--model', 'gpt-6.1-sol']);
});
test('Sol: a calibrated card naming Sol maps through its alias; a missing Sol row blocks card-cheaper', () => {
  const winner = choose({}, { cards: { 'multi-step-coding': card('CALIBRATED', 'openai/gpt-6.1-sol') } });
  assert.equal(winner.route, 'sol'); assert.equal(winner.basis, 'card');
  const cheaper = card('NO_CLEAR_WINNER'); assert.equal(choose({}, { cards: { 'multi-step-coding': cheaper } }).route, 'sonnet');
  const inPool = card('NO_CLEAR_WINNER', 'openai/gpt-6.1-sol'); inPool.models[2].cost_per_accepted_usd = 0.001;
  const pooled = choose({}, { quota: codexWins(), cards: { 'multi-step-coding': inPool } });
  assert.equal(pooled.route, 'sol'); assert.equal(pooled.basis, 'card-cheaper');
  const missing = card('NO_CLEAR_WINNER'); missing.models.pop();
  const d = choose({}, { cards: { 'multi-step-coding': missing } });
  assert.equal(d.basis, 'trial'); assert.match(d.why.join(' '), /costs unknown, incomparable or not cheaper/);
});
test('Sol: --require-quota still blocks a trial when a compared pool is unreadable', () => {
  assert.equal(choose({ requireQuota: true }, { quota: { codex: quota.codex } }).status, 'blocked');
});

const FULL = '2026-10-05';
const isMetered = d => policy.routes[d.route]?.pool === 'metered';

test('ceiling: the policy sets 95 and validates it between 50 and 100', () => {
  assert.equal(policy.quota.ceilingPercent, 95);
  for (const value of [49.9, 100.1, '95', null, undefined]) {
    const p = structuredClone(policy);
    if (value === undefined) delete p.quota.ceilingPercent; else p.quota.ceilingPercent = value;
    assert.equal(validatePolicy(p).ok, false, String(value));
  }
  for (const value of [50, 100]) {
    const p = structuredClone(policy); p.quota.ceilingPercent = value;
    assert.equal(validatePolicy(p).ok, true, String(value));
  }
});
test('ceiling: Claude 5h at 75% and Codex weekly at 90% choose by pace, with no metered route', () => {
  const d = choose({}, { quota: changed(75, 90) });
  assert.equal(d.status, 'ok'); assert.equal(isMetered(d), false);
  assert.match(d.notes.join(' '), /conflicting quota preferences ignored/);
  assert.equal(d.route, 'sonnet'); assert.match(d.why.join(' '), /weekly headroom/);
});
test('ceiling: Codex weekly at 96% exhausts Codex and leaves Sonnet', () => {
  const d = choose({}, { quota: changed(50, 96) });
  assert.equal(d.status, 'ok'); assert.equal(d.route, 'sonnet');
  for (const route of ['astra', 'sol']) {
    assert.ok(d.alternatives.some(a => a.route === route && /codex weekly 96% ≥ 95% ceiling: pool exhausted/.test(a.rejected)), route);
  }
  assert.match(d.why.join(' '), /codex weekly 96% ≥ 95% ceiling: pool exhausted/);
});
test('ceiling: 95 is the line; 94.9 stays in use and any readable window counts', () => {
  const near = choose({}, { quota: changed(50, 94.9, 20) });
  assert.ok(['astra', 'sol', 'sonnet'].includes(near.route));
  assert.equal(choose({}, { quota: changed(50, 95) }).route, 'sonnet');
  // Claude weekly at 95% exhausts Claude even while its 5h window is low.
  const weekly = choose({}, { quota: changed(10, 50, 95) });
  assert.ok(['astra', 'sol'].includes(weekly.route));
  assert.match(weekly.why.join(' '), /claude weekly 95% ≥ 95% ceiling/);
});
test('ceiling: both subscriptions at 96% offer metered for tier 1 and 2, and block tier 3', () => {
  const q = changed(96, 96);
  const two = choose({}, { quota: q });
  assert.equal(two.status, 'needs_approval'); assert.equal(two.route, 'fw-kimi-k3');
  assert.match(two.why.join(' '), /ceiling or cooldowns/);
  const one = choose({ kind: 'quick-edit' }, { quota: changed(50, 96), limits: { muse: FULL } });
  assert.equal(one.status, 'needs_approval'); assert.ok(isMetered(one));
  const three = choose({ kind: 'architecture' }, { quota: q });
  assert.equal(three.status, 'blocked'); assert.match(three.why.join(' '), /no allowed metered fallback for tier 3/);
});
test('ceiling: Claude reserved at 85% with Codex at 96% blocks tier 2 instead of offering metered', () => {
  for (const input of [{}, { kind: 'migration' }, { kind: 'hard-bug-fix' }]) {
    const d = choose(input, { quota: changed(85, 96) });
    assert.equal(d.status, 'blocked', input.kind); assert.equal(d.route, undefined);
    assert.ok(!d.alternatives.some(a => isMetered({ route: a.route }) && !/superseded|disabled/.test(a.rejected)));
    assert.match(d.why.join(' '), /held back only by the Claude reserve/);
    assert.match(d.why.join(' '), /codex weekly 96%/);
  }
  // A main thread may use the reserved Claude pool, so nothing is exhausted.
  assert.equal(choose({ mainThread: true }, { quota: changed(85, 96) }).route, 'sonnet');
});
test('ceiling: Muse on cooldown with Luna\'s pool at 96% offers metered on tier 1', () => {
  const d = choose({ kind: 'quick-edit' }, { quota: changed(50, 96), limits: { muse: FULL } });
  assert.equal(d.status, 'needs_approval'); assert.equal(d.route, 'fw-deepseek-v4p1-flash');
  assert.ok(d.alternatives.some(a => a.route === 'luna' && /ceiling: pool exhausted/.test(a.rejected)));
  assert.ok(d.alternatives.some(a => a.route === 'muse' && /limit cooldown/.test(a.rejected)));
  // Luna's pool at 96% alone leaves Muse, with no metered route.
  assert.equal(choose({ kind: 'quick-edit' }, { quota: changed(50, 96) }).route, 'muse');
});
test('ceiling: it removes repo-rule routes and ignores bulk-text on the local pool', () => {
  const d = choose({ kind: '3d-work' }, { repo: 'acme/studio-3d', quota: changed(50, 96) });
  assert.equal(d.route, 'sonnet');
  assert.ok(d.alternatives.some(a => a.route === 'astra' && /ceiling: pool exhausted/.test(a.rejected)));
  assert.equal(choose({ kind: 'bulk-text' }, { quota: changed(99, 99) }).route, 'pi-local');
});
test('ceiling: exclusions, machine limits and repo rules still never trigger metered', () => {
  const q = changed(96, 96);
  for (const [input, deps] of [
    [{ kind: 'quick-edit', machine: 'pc' }, { limits: { luna: FULL } }],
    [{ kind: 'quick-edit' }, { repo: 'acme/kit-lib', limits: { luna: FULL } }],
    [{ kind: 'first-pass-review', author: 'openai' }, { limits: { muse: FULL, luna: FULL } }],
  ]) {
    const d = choose(input, { quota: q, ...deps }); assert.equal(d.status, 'blocked', JSON.stringify(input));
  }
});
test('ceiling: unknown or expired quota applies no ceiling', () => {
  assert.notEqual(choose({}, { quota: null }).status, 'blocked');
  const stale = changed(96, 96);
  for (const pool of Object.values(stale)) for (const w of pool.windows) w.resetsAt = '2026-10-04T10:00:00Z';
  assert.equal(choose({}, { quota: stale }).status, 'ok');
});

for (const kind of Object.keys(policy.kinds).filter(k => policy.kinds[k].tier === 2)) {
  test(`both soft limits at once: ${kind} chooses by pace with a note, never blocked`, () => {
    const d = choose({ kind }, { quota: changed(72, 88) });
    assert.equal(d.status, 'ok'); assert.notEqual(d.status, 'blocked');
    assert.ok(['sonnet', 'astra', 'sol'].includes(d.route)); assert.equal(isMetered(d), false);
    assert.match(d.notes.join(' '), /conflicting quota preferences ignored; choose by pace/);
    assert.match(d.why.join(' '), /weekly headroom/);
  });
}

test('a repo or file rule naming a metered route is offered with room to spare, and still needs approval', () => {
  const p = structuredClone(policy); p.repos['test/metered'] = { rules: override('fw-kimi-k3').rules };
  for (const deps of [{ override: override('fw-kimi-k3') }, { policy: p, repo: 'test/metered' }]) {
    const d = choose({}, { quota: changed(20, 20), ...deps });
    assert.equal(d.route, 'fw-kimi-k3'); assert.equal(d.status, 'needs_approval');
    assert.equal(d.spawn, null); assert.equal(d.spendApproved, false);
    assert.doesNotMatch(d.why.join(' '), /ceiling|metered fallback/);
    assert.equal(choose({ approvedRoutes: ['fw-kimi-k3'] }, { quota: changed(20, 20), ...deps }).status, 'ok');
  }
});
test('ceiling: a main thread at exactly 95% Claude weekly loses Claude; at 94.9% it keeps it', () => {
  const full = changed(10, 50, 95);
  assert.ok(['astra', 'sol'].includes(choose({ mainThread: true }, { quota: full }).route));
  const tier3 = choose({ kind: 'architecture', mainThread: true }, { quota: full });
  assert.equal(tier3.route, 'astra'); assert.match(tier3.why.join(' '), /claude weekly 95% ≥ 95% ceiling: pool exhausted/);
  assert.equal(choose({ kind: 'architecture', mainThread: true }, { quota: changed(10, 50, 94.9) }).route, 'opus');
});
test('ceiling: with one window exhausted and another missing, --require-quota still sees the ceiling', () => {
  const partial = changed(96, 19); partial.claude.windows = partial.claude.windows.filter(w => w.kind === 'five-hour');
  const tier3 = choose({ kind: 'architecture', requireQuota: true }, { quota: partial });
  assert.equal(tier3.route, 'astra'); assert.match(tier3.why.join(' '), /claude 5h 96% ≥ 95% ceiling/);
  assert.doesNotMatch(tier3.why.join(' '), /required quota missing/);
  // Tier 2 leaves Claude, so the missing Claude weekly window no longer matters.
  const tier2 = choose({ requireQuota: true }, { quota: partial });
  assert.equal(tier2.status, 'ok'); assert.ok(['astra', 'sol'].includes(tier2.route));
  assert.match(tier2.notes.join(' '), /quota unknown: hard stops not applied/);
  // With Codex unreadable as well, the chosen pool has no quota and the strict flag blocks.
  delete partial.codex;
  const strict = choose({ requireQuota: true }, { quota: partial });
  assert.equal(strict.status, 'blocked'); assert.match(strict.why.join(' '), /required quota missing for codex/);
});
test('ceiling: model-specific windows are ignored, and cannot hide a full pool', () => {
  const modelWindow = (usedPercent, kind) => ({ label: 'Model weekly', kind, model: 'fable', usedPercent, resetsAt: '2026-10-08T17:00:00.000Z' });
  const noisy = changed(59, 19);
  noisy.claude.windows.push(modelWindow(99, 'weekly'), modelWindow(99, 'five-hour')); noisy.codex.windows.push(modelWindow(99, 'weekly'));
  const d = choose({ kind: 'architecture' }, { quota: noisy });
  assert.equal(d.route, 'opus'); assert.equal(d.quota.claude.weekly.used, 33);
  assert.doesNotMatch(d.why.join(' '), /ceiling/);
  assert.ok(['sonnet', 'astra', 'sol'].includes(choose({}, { quota: noisy }).route));
  const full = changed(59, 96); full.codex.windows.push(modelWindow(1, 'weekly'));
  assert.equal(choose({}, { quota: full }).route, 'sonnet');
});
test('kind descriptions carry the precedence Jev needs', () => {
  const text = id => policy.kinds[id].description;
  for (const id of ['ios', 'ui-visual', '3d-work', 'data-contract', 'user-facing-copy']) {
    assert.match(text(id), /Wins over .*quick-edit, bounded-build and multi-step-coding; tests-only work is write-tests/);
    assert.doesNotMatch(text(id), /including iOS tests/);
  }
  for (const id of ['quick-edit', 'bounded-build']) assert.match(text(id), /Domain kinds .* win/);
  assert.match(text('write-tests'), /in any codebase, including iOS/); assert.doesNotMatch(text('write-tests'), /iOS tests are ios/);
  assert.match(text('simple-bug-fix'), /stack trace or repro that points to the failing code counts as an obvious cause/);
  assert.match(text('hard-bug-fix'), /repro or trace does not point to the cause/); assert.match(text('migration'), /Wins over multi-step-coding/);
  assert.match(text('first-pass-review'), /Muse or tier-1/); assert.match(text('routine-review'), /tier-2/);
  assert.match(text('high-risk-review'), /Wins over the other review kinds/);
  assert.match(text('simple-bug-fix'), /known/); assert.match(text('simple-bug-fix'), /hard-bug-fix/);
  assert.match(text('hard-bug-fix'), /even if the symptom reproduces/);
});

test('exhausted Claude high-risk review uses an independent GPT model', () => {
  const d = choose({ kind: 'high-risk-review', authorModels: ['gpt-6-astra', 'gpt-6.1-sol'] }, { quota: changed(100, 33) });
  assert.equal(d.status, 'ok'); assert.equal(d.route, 'sol-review'); assert.equal(d.model, 'gpt-6-sol');
  assert.deepEqual(d.authorModels, ['gpt-6-astra', 'gpt-6.1-sol']);
  assert.ok(d.alternatives.some(a => a.route === 'astra' && /authored/.test(a.rejected)));
  assert.ok(d.alternatives.some(a => a.route === 'sol' && /authored/.test(a.rejected)));
});
test('all author models excluded blocks instead of granting self review or paid fallback', () => {
  const d = choose({ kind: 'high-risk-review', authorModels: [' GPT-6-Astra ', 'gpt-6.1-sol', 'gpt-6-sol'] }, { quota: changed(100, 33) });
  assert.equal(d.status, 'blocked'); assert.equal(d.spendApproved, false);
});
test('review independence cannot bypass a Codex quota ceiling or vendor exclusion', () => {
  assert.equal(choose({ kind: 'high-risk-review', authorModels: ['gpt-6-astra'] }, { quota: changed(100, 100) }).status, 'blocked');
  assert.equal(choose({ kind: 'high-risk-review', author: 'openai' }, { quota: changed(100, 33) }).status, 'blocked');
});
test('model exclusion applies across aliases and rejects malformed lists', () => {
  const p = structuredClone(policy); p.routes['sol-review'].model = 'gpt-6-astra';
  const d = choose({ kind: 'high-risk-review', authorModels: ['gpt-6-astra', 'gpt-6.1-sol'] }, { policy: p, quota: changed(100, 33) });
  assert.equal(d.status, 'blocked');
  for (const authorModels of ['gpt-6-astra', [null], [' ']]) assert.throws(() => choose({ authorModels }), /authorModels/);
});

test('installed preserve-route behavior survives GPT fallback and still honors ceilings', () => {
  const rule = override('sol'); rule.rules[0].preserveRouteAfterFailures = true;
  assert.equal(choose({ failures: 4 }, { override: rule }).route, 'sol');
  assert.notEqual(choose({ failures: 4 }, { override: rule, quota: changed(20, 100) }).route, 'sol');
});
