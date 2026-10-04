import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPolicy, validatePolicy } from './policy.mjs';
import { pick, quotaPace } from './pick.mjs';
import { normalizeQuota, readQuota, buildSpawn } from './adapters/bb.mjs';
const policy = loadPolicy();
const now = '2026-10-04T15:35:00Z';
const sample = JSON.parse(readFileSync(new URL('./fixtures/quota.json', import.meta.url), 'utf8'));
const quota = normalizeQuota(sample);
const choose = (input = {}, deps = {}) => pick({ kind: 'multi-step-coding', ...input }, { policy, now, quota, id: 'dec_test', ...deps });
function changed(claude = 59, codex = 19, weekly = 33) {
  const q = structuredClone(quota);
  q.claude.windows[0].usedPercent = claude; q.codex.windows[0].usedPercent = codex; q.claude.windows[1].usedPercent = weekly;
  return q;
}
function card(trust = 'CALIBRATED', recommend = 'anthropic/claude-sonnet-5.5', generated = '2026-10-04') {
  return { task: 'implementation', trust, recommend, generated, models: [
    { model: 'anthropic/claude-sonnet-5.5', cost_per_accepted_usd: 0.01, cost_source: 'reported' },
    { model: 'openai/gpt-6-astra', cost_per_accepted_usd: 0.02, cost_source: 'reported' },
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
  assert.equal(choose({ kind: '3d-work' }, { repo: 'srbryers/flora-studio' }).route, 'astra');
  const game = choose({ kind: 'quick-edit' }, { repo: 'srbryers/fathoms-game' });
  assert.equal(game.machine, 'pc'); assert.equal(game.route, 'luna');
  assert.ok(game.alternatives.some(a => a.route === 'muse'));
  assert.equal(choose({ kind: 'data-contract' }, { repo: 'srbryers/wedding' }).route, 'astra');
  const external = choose({ kind: 'user-facing-copy' }, { repo: 'srbryers/prelude-social-skills-coach' });
  assert.equal(external.status, 'external'); assert.equal(external.requiresSpendApproval, true);
  assert.ok(external.instruction); assert.equal(buildSpawn(external, {}), undefined);
  assert.match(external.notes.join(' '), /author never approves/);
  for (const kind of Object.keys(policy.kinds)) assert.notEqual(choose({ kind }, { repo: 'srbryers/ui-kit' }).route, 'muse');
});
test('two failures moves up one tier and skips an escalated repo route', () => {
  const d = choose({ kind: 'quick-edit', failures: 2 }); assert.ok(['sonnet', 'astra'].includes(d.route));
  const repo = choose({ kind: 'quick-edit', failures: 2 }, { repo: 'srbryers/prelude-social-skills-coach' });
  assert.notEqual(repo.route, 'terra'); assert.match(repo.why.join(' '), /escalated repo route skipped/);
});
test('review excludes author vendor, including a repo override', () => {
  for (const kind of policy.review.kinds) {
    const d = choose({ kind, author: 'astra' }, { repo: 'srbryers/flora-studio' });
    assert.ok(!['astra', 'luna'].includes(d.route));
  }
  const d = choose({ kind: 'high-risk-review', author: 'anthropic' });
  assert.equal(d.route, 'astra'); assert.match(d.why.join(' '), /nearest/);
});
test('review fallback still respects exclusions, machine, quota and cooldown', () => {
  const d = choose({ kind: 'high-risk-review', author: 'anthropic', machine: 'pc' }, { limits: { astra: '2026-10-05', luna: '2026-10-05' } });
  assert.equal(d.status, 'blocked');
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
test('Muse cooldown uses Luna until expiry; all limited blocks except available bulk local', () => {
  const limits = { muse: '2026-10-04T16:00:00Z' };
  assert.equal(choose({ kind: 'quick-edit' }, { limits }).route, 'luna');
  assert.equal(choose({ kind: 'quick-edit' }, { limits, now: '2026-10-04T16:00:00Z' }).route, 'muse');
  limits.luna = limits.muse;
  assert.equal(choose({ kind: 'quick-edit' }, { limits }).status, 'blocked');
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
  const d = choose({ kind: 'data-contract', failures: 2 }, { repo: 'srbryers/wedding' });
  assert.equal(d.route, 'opus'); assert.match(d.why.join(' '), /escalated repo route skipped/);
});
test('central plus file exclusions can block a kind and retain all explanations', () => {
  const file = { policyVersion: 1, rules: [{ kinds: ['*'], excludeRoutes: ['luna'], source: 'fixture', why: 'test constraint' }] };
  const d = choose({ kind: 'quick-edit' }, { repo: 'srbryers/ui-kit', override: file });
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
  const d = choose({ kind: 'user-facing-copy' }, { policy: p, repo: 'srbryers/prelude-social-skills-coach',
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
  assert.equal(choose({ kind: 'quick-edit', requireQuota: true }).status, 'blocked');
  assert.equal(choose({ kind: 'user-facing-copy', requireQuota: true }, { repo: 'srbryers/prelude-social-skills-coach', quota: null }).status, 'external');
});
test('repo and file rules outrank calibrated cards', () => {
  for (const deps of [{ repo: 'srbryers/prelude-social-skills-coach' }, { override: override('gpt-5.5') }]) {
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
  assert.equal(d.route, 'astra'); assert.equal(d.basis, 'policy');
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
      && a.rejected === 'repo rule on sonnet blocked by quota: Claude 5h 75% > 70'));
  }
});
test('a lone Codex threshold blocks the Flora Astra rule and chooses Sonnet', () => {
  const d = choose({ kind: '3d-work' }, { repo: 'srbryers/flora-studio', quota: changed(59, 90) });
  assert.equal(d.route, 'sonnet'); assert.equal(d.basis, 'policy');
  assert.ok(d.alternatives.some(a => a.route === 'astra'
    && a.rejected === 'repo rule on astra blocked by quota: Codex weekly 90% > 85'));
});
test('a lone preference falls back when its target pool is limited or excluded', () => {
  const excluded = { policyVersion: 1, rules: [{ kinds: ['multi-step-coding'], excludeRoutes: ['astra'], source: 'fixture', why: 'unavailable' }] };
  for (const constraint of [{ limits: { astra: '2026-10-05' } }, { override: excluded }]) {
    const d = choose({}, { quota: changed(75), ...constraint });
    assert.equal(d.route, 'sonnet'); assert.equal(d.basis, 'policy');
    assert.ok(d.notes.some(n => /no allowed codex candidate, falling back to claude/.test(n)));
  }
  const reverse = choose({}, { quota: changed(59, 90), limits: { sonnet: '2026-10-05' } });
  assert.equal(reverse.route, 'astra'); assert.match(reverse.notes.join(' '), /falling back to codex/);
});
test('preference fallback cannot undo the 80 percent reservation or an exhausted candidate list', () => {
  assert.equal(choose({}, { quota: changed(81), limits: { astra: '2026-10-05' } }).status, 'blocked');
  assert.equal(choose({}, { quota: changed(75), limits: { astra: '2026-10-05', sonnet: '2026-10-05' } }).status, 'blocked');
});
