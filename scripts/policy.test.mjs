import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TRUST } from './card.mjs';
import { loadPolicy, loadOverride, validatePolicy, validateOverride,
  kindsForClassifier, resolveCandidates, parseRepoUrl, repoKey } from './policy.mjs';

const policy = loadPolicy();
const copy = () => structuredClone(policy);
const repoEntry = name => policy.repos[`srbryers/${name}`];
const example = () => JSON.parse(readFileSync(new URL('../policy/examples/example.model-routing.json', import.meta.url), 'utf8'));
const rule = (route, kinds = ['quick-edit'], extra = {}) => ({ policyVersion: 1,
  rules: [{ kinds, route, source: 'AGENTS.md', why: 'Repo rule.', ...extra }] });
const ids = candidates => candidates.map(c => c.route);

function invalid(result, pattern) {
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => pattern.test(e)), JSON.stringify(result.errors));
}

test('default policy validates, preserves all 23 kinds, and matches the trust gate', () => {
  assert.deepEqual(validatePolicy(policy), { ok: true, errors: [] });
  assert.equal(Object.keys(policy.kinds).length, 23);
  assert.equal(policy.cards.maxAgeDays, TRUST.STALE_DAYS);
  assert.equal(policy.policyVersion, 1);
  assert.equal(policy.updated, '2026-10-04');
  assert.equal(policy.quota.overridesBeatHardStops, false);
  assert.deepEqual(policy.quota.thresholds.map(r => [r.pool, r.window, r.usedPercentAbove]),
    [['claude', 'five-hour', 70], ['claude', 'five-hour', 80], ['codex', 'weekly', 85]]);
  assert.deepEqual(policy.quota.limitErrors, [{ route: 'muse', fallback: 'luna', cooldownHours: 5 }]);
});
for (const name of ['wedding', 'fathoms-game', 'flora-studio']) {
  test(`${name} central repo rules validate`, () => assert.deepEqual(validateOverride({ policyVersion: 1, ...repoEntry(name) }, policy), { ok: true, errors: [] }));
}

const badPolicies = [
  ['unsupported version', p => p.policyVersion = 2, /unsupported policyVersion/],
  ['unknown candidate route', p => p.kinds.docs.candidates = ['typo'], /candidates: unknown route id typo/],
  ['unknown fallback route', p => p.kinds.docs.fallbacks = ['typo'], /fallbacks: unknown route id typo/],
  ['contributor model', p => p.routes.astra.model = 'muse-spark-contributor', /contributor routes are forbidden/],
  ['Sonnet max', p => p.kinds['routine-review'].reasoning = 'max', /sonnet reasoning max exceeds cap xhigh/],
  ['Sonnet cap removed', p => delete p.routes.sonnet.maxReasoning, /Sonnet maxReasoning must be xhigh/],
  ['bad reasoning', p => p.kinds.docs.reasoning = 'ultra', /reasoning must be low\|medium\|high\|xhigh\|max/],
  ['missing reasoning', p => delete p.kinds.docs.reasoning, /reasoning is required/],
  ['null paid reasoning', p => p.kinds.docs.reasoning = null, /reasoning must be/],
  ['missing description', p => delete p.kinds.docs.description, /description is required/],
  ['blank description', p => p.kinds.docs.description = '  ', /description is required/],
  ['missing kind', p => delete p.kinds.docs, /kinds.docs is required/],
  ['extra kind', p => p.kinds.new = p.kinds.docs, /unknown kind new/],
  ['Muse on PC', p => p.routes.muse.machines.push('pc'), /Muse is mac-studio only/],
  ['Claude via other harness', p => p.routes.opus.provider = 'pi', /pool claude requires provider claude-code/],
  ['Claude provider restriction removed', p => delete p.pools.claude.requiredProvider, /requiredProvider must be claude-code/],
  ['unknown pool', p => p.routes.astra.pool = 'typo', /unknown pool typo/],
  ['unknown machine', p => p.routes.astra.machines = ['typo'], /unknown id typo/],
  ['bad tier', p => p.kinds.docs.tier = 4, /tier is unsupported/],
  ['missing fallbacks', p => delete p.kinds.docs.fallbacks, /fallbacks is required/],
  ['overlapping candidates', p => p.kinds.docs.fallbacks.push('muse'), /must not overlap/],
  ['skill Muse fallback', p => p.kinds['skill-workflow'].fallbacks.push('muse'), /Muse cannot follow skills/],
  ['missing skill exclusion', p => delete p.kinds['skill-workflow'].excludedRoutes, /excludedRoutes must include muse/],
  ['bad escalation threshold', p => p.escalation.escalateAfterFailures = 0, /must be a positive integer/],
  ['skipping escalation tier', p => p.escalation.steps['1'].tier = 3, /must advance one tier/],
  ['bad quota threshold', p => p.quota.thresholds[0].usedPercentAbove = 101, /between 0 and 100/],
  ['bad quota window', p => p.quota.thresholds[0].window = 'daily', /unknown window daily/],
  ['quota override bypass', p => p.quota.overridesBeatHardStops = true, /must be false/],
  ['bad cooldown', p => p.quota.limitErrors[0].cooldownHours = -1, /cooldownHours must be positive/],
  ['bad tie-break', p => p.tieBreak.tieBreak = 'raw-percent', /must be pace/],
  ['same vendor review', p => p.review.differentVendor = false, /must be true/],
  ['untrusted cards', p => p.cards.requireTrust = 'SINGLE_CANDIDATE', /must be CALIBRATED/],
  ['stale card drift', p => p.cards.maxAgeDays = 31, /must match TRUST.STALE_DAYS/],
  ['invalid date', p => p.updated = '2026-02-30', /valid YYYY-MM-DD/],
  ['invalid repo key', p => p.repos['not-a-repo'] = p.repos['srbryers/wedding'], /invalid GitHub repo key/],
  ['invalid repo rule', p => p.repos['srbryers/wedding'].rules[0].route = 'typo', /repos.srbryers\/wedding.*unknown route id/],
  ['central PC-only Muse', p => p.repos['srbryers/fathoms-game'].rules[0].route = 'muse', /Muse is mac-studio only/],
  ['typo field', p => p.kinds.docs.reasning = 'high', /reasning is not supported/],
];
for (const [name, change, pattern] of badPolicies) {
  test(`validatePolicy catches ${name}`, () => { const p = copy(); change(p); invalid(validatePolicy(p), pattern); });
}

test('validators report malformed shapes without throwing', () => {
  for (const value of [null, [], false, 4, 'bad', {}]) assert.equal(validatePolicy(value).ok, false);
  for (const key of Object.keys(policy)) {
    const p = copy(); p[key] = null;
    assert.equal(validatePolicy(p).ok, false, key);
  }
  for (const [section, key] of [['routes', 'muse'], ['pools', 'claude'], ['tiers', '1'], ['kinds', 'docs']]) {
    const p = copy(); p[section][key] = null;
    assert.equal(validatePolicy(p).ok, false);
  }
  for (const value of [null, [], {}, { policyVersion: 1, rules: [null] }]) assert.equal(validateOverride(value, policy).ok, false);
  assert.equal(validateOverride(rule('muse'), null).ok, false);
});

const badOverrides = [
  ['version', () => ({ ...rule('astra'), policyVersion: 2 }), /unsupported policyVersion/],
  ['unknown kind', () => rule('astra', ['typo']), /unknown kind typo/],
  ['unknown route', () => rule('typo'), /unknown route id typo/],
  ['PC-only Muse', () => ({ ...rule('muse'), machines: ['pc'] }), /Muse is mac-studio only/],
  ['PC-only Pi', () => ({ ...rule('pi-local', ['bulk-text']), machines: ['pc'] }), /unavailable on repo machines pc/],
  ['reasoning', () => rule('astra', ['docs'], { reasoning: 'ultra' }), /reasoning must be/],
  ['Sonnet max', () => rule('sonnet', ['docs'], { reasoning: 'max' }), /exceeds cap xhigh/],
  ['missing source', () => rule('astra', ['docs'], { source: '' }), /source is required/],
  ['missing why', () => rule('astra', ['docs'], { why: '' }), /why is required/],
  ['Muse skill work', () => rule('muse', ['skill-workflow']), /excluded for skill-workflow/],
  ['duplicate rules', () => { const o = rule('astra'); o.rules.push(...rule('luna').rules); return o; }, /duplicate rule for kind/],
  ['empty machines', () => ({ ...rule('astra'), machines: [] }), /at least 1/],
  ['unknown machines', () => ({ ...rule('astra'), machines: ['laptop'] }), /unknown id laptop/],
];
for (const [name, make, pattern] of badOverrides) {
  test(`validateOverride catches ${name}`, () => invalid(validateOverride(make(), policy), pattern));
}

test('loadPolicy deeply freezes data and accepts an explicit path', () => {
  const p = loadPolicy(new URL('../policy/policy.json', import.meta.url));
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.routes.muse.machines));
  assert.throws(() => p.kinds.docs.candidates.push('astra'), TypeError);
});

test('default policy loader works from an unrelated cwd', () => {
  const moduleURL = new URL('./policy.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { loadPolicy } from ${JSON.stringify(moduleURL)}; console.log(loadPolicy().policyVersion);`],
  { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), '1');
});

test('loaders distinguish absence, malformed JSON and invalid data; freeze overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routing-policy-'));
  const path = join(dir, '.model-routing.json');
  try {
    assert.equal(loadOverride(dir), null);
    writeFileSync(path, JSON.stringify(example()));
    const o = loadOverride(dir);
    assert.ok(Object.isFrozen(o.rules[0].kinds));
    assert.equal(o.rules[0].route, 'luna');
    writeFileSync(path, '{');
    assert.throws(() => loadOverride(dir), SyntaxError);
    assert.throws(() => loadPolicy(path), SyntaxError);
    writeFileSync(path, JSON.stringify(rule('unknown')));
    assert.throws(() => loadOverride(dir), /unknown route id unknown/);
    assert.throws(() => loadPolicy(path), /Invalid policy/);
    assert.throws(() => loadOverride(path), { code: 'ENOTDIR' });
    assert.throws(() => loadPolicy(join(dir, 'missing')), { code: 'ENOENT' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('classifier receives exactly the fixed IDs and descriptions', () => {
  const rows = kindsForClassifier(policy);
  assert.deepEqual(rows, Object.entries(policy.kinds).map(([id, k]) => ({ id, description: k.description })));
  rows[0].description = 'changed';
  assert.notEqual(rows[0].description, policy.kinds[rows[0].id].description);
});

test('tier 1: Muse first on Mac, Luna on PC', () => {
  const mac = resolveCandidates(policy, 'quick-edit', { machine: 'mac-studio' }).candidates;
  assert.deepEqual(ids(mac), ['muse', 'luna']);
  assert.deepEqual(mac[0], { route: 'muse', type: 'bb', provider: 'acp-muse', model: 'muse-spark-1.3',
    reasoning: 'medium', machines: ['mac-studio'], pool: 'muse', vendor: 'meta', tier: 1, source: 'kind', fallback: false, escalated: false, reason: 'policy kind quick-edit, tier 1' });
  assert.deepEqual(ids(resolveCandidates(policy, 'quick-edit', { machine: 'pc' }).candidates), ['luna']);
});

test('skill-workflow never yields Muse, including escalation', () => {
  for (const machine of ['mac-studio', 'pc']) for (const failures of [0, 1, 2, 4]) {
    assert.ok(!ids(resolveCandidates(policy, 'skill-workflow', { machine, failures }).candidates).includes('muse'));
  }
});

test('two failures escalate quick-edit once to tier 2 at high', () => {
  assert.deepEqual(ids(resolveCandidates(policy, 'quick-edit', { failures: 1 }).candidates), ['muse', 'luna']);
  for (const failures of [2, 4]) {
    const result = resolveCandidates(policy, 'quick-edit', { failures }).candidates;
    assert.deepEqual(ids(result), ['sonnet', 'astra']);
    assert.ok(result.every(c => c.reasoning === 'high' && c.reason.includes('tier 1 -> 2')));
  }
});

test('two failures escalate tier 2 to Opus xhigh; terminal tiers stay unchanged', () => {
  const result = resolveCandidates(policy, 'routine-review', { failures: 2 }).candidates;
  assert.deepEqual(ids(result), ['opus']);
  assert.equal(result[0].reasoning, 'xhigh');
  for (const kind of ['ui-visual', 'bulk-text', 'image-generation']) {
    assert.deepEqual(resolveCandidates(policy, kind, { failures: 2 }).candidates, resolveCandidates(policy, kind).candidates);
  }
});

test('flora: Astra for 3D, Luna for review; overrides deduplicate and retain policy fallbacks', () => {
  const repo = 'srbryers/flora-studio';
  assert.deepEqual(ids(resolveCandidates(policy, '3d-work', { repo }).candidates), ['astra', 'sonnet']);
  assert.deepEqual(ids(resolveCandidates(policy, 'first-pass-review', { repo }).candidates), ['luna', 'muse']);
  assert.equal(resolveCandidates(policy, 'routine-review', { repo }).candidates[0].route, 'luna');
  assert.match(resolveCandidates(policy, '3d-work', { repo }).candidates[0].reason, /CLAUDE.md/);
});

test('fathoms: all kinds are PC-only and never use Muse or Pi', () => {
  const repo = 'srbryers/fathoms-game';
  for (const kind of Object.keys(policy.kinds)) {
    const result = resolveCandidates(policy, kind, { repo }).candidates;
    assert.ok(result.length > 0);
    assert.ok(result.every(c => !['muse', 'pi-local'].includes(c.route)));
    assert.ok(result.every(c => JSON.stringify(c.machines) === '["pc"]'));
  }
  assert.equal(resolveCandidates(policy, 'architecture', { repo }).candidates[0].route, 'astra');
  assert.deepEqual(resolveCandidates(policy, 'quick-edit', { repo, machine: 'mac-studio' }).candidates, []);
});

test('wedding routes contracts to Astra and only notes its contract-review rule', () => {
  const repo = 'srbryers/wedding';
  assert.equal(resolveCandidates(policy, 'data-contract', { repo }).candidates[0].route, 'astra');
  const review = resolveCandidates(policy, 'high-risk-review', { repo }).candidates[0];
  assert.equal(review.route, 'opus');
  assert.equal(review.note, 'data-contract reviews go to OpenAI (AGENTS.md)');
});

test('override beats escalation; explicit effort wins, inherited effort is capped', () => {
  const result = resolveCandidates(policy, 'quick-edit', { failures: 2, override: rule('luna', ['quick-edit'], { reasoning: 'low' }) }).candidates;
  assert.deepEqual(ids(result), ['luna', 'sonnet', 'astra']);
  assert.equal(result[0].reasoning, 'low');
  const p = copy(); p.kinds.architecture.reasoning = 'max';
  const capped = resolveCandidates(p, 'architecture', { override: rule('sonnet', ['architecture']) }).candidates;
  assert.equal(capped[0].reasoning, 'xhigh');
  assert.match(capped[0].reason, /capped at xhigh/);
});

test('Sonnet never exceeds xhigh across all kinds, failures and inherited overrides', () => {
  for (const kind of Object.keys(policy.kinds)) for (const failures of [0, 1, 2, 4]) {
    const result = resolveCandidates(policy, kind, { failures, override: rule('sonnet', [kind]) }).candidates;
    assert.ok(result.filter(c => c.route === 'sonnet').every(c => c.reasoning === null || ['low', 'medium', 'high', 'xhigh'].includes(c.reasoning)));
  }
});

test('local and image candidates carry no effort; local paid fallback uses medium', () => {
  const local = resolveCandidates(policy, 'bulk-text').candidates;
  assert.deepEqual(ids(local), ['pi-local', 'muse', 'luna']);
  assert.deepEqual(local.map(c => c.reasoning), [null, 'medium', 'medium']);
  const image = resolveCandidates(policy, 'image-generation').candidates;
  assert.deepEqual(ids(image), ['astra']);
  assert.equal(image[0].reasoning, null);
});

test('resolver is deterministic, rejects invalid input and never mutates inputs', () => {
  const override = example();
  const before = structuredClone(override);
  const result = resolveCandidates(policy, '3d-work', { override }).candidates;
  assert.deepEqual(result, resolveCandidates(policy, '3d-work', { override }).candidates);
  result[0].machines.push('fake');
  assert.deepEqual(override, before);
  assert.ok(!policy.routes.astra.machines.includes('fake'));
  assert.throws(() => resolveCandidates(policy, 'unknown').candidates, /Unknown kind/);
  assert.throws(() => resolveCandidates(policy, 'constructor').candidates, /Unknown kind/);
  assert.throws(() => resolveCandidates(policy, 'docs', { machine: 'unknown' }).candidates, /Unknown machine/);
  for (const failures of [-1, 1.5, NaN, '2']) assert.throws(() => resolveCandidates(policy, 'docs', { failures }).candidates, /nonnegative integer/);
  assert.throws(() => resolveCandidates(policy, 'docs', { override: rule('sonnet', ['docs'], { reasoning: 'max' }) }).candidates, /Invalid override/);
});

test('generic override example validates', () => {
  assert.deepEqual(validateOverride(example(), policy), { ok: true, errors: [] });
});

test('file rules beat central rules; unmatched kinds and omitted machines inherit repo settings', () => {
  const repo = 'srbryers/fathoms-game';
  const override = rule('sonnet', ['architecture'], { reasoning: 'high' });
  const result = resolveCandidates(policy, 'architecture', { repo, override }).candidates;
  assert.deepEqual(ids(result), ['sonnet', 'astra', 'opus']);
  assert.match(result[0].reason, /repo override/);
  assert.match(result[1].reason, /policy repo srbryers\/fathoms-game/);
  assert.ok(result.every(c => JSON.stringify(c.machines) === '["pc"]'));
  assert.equal(resolveCandidates(policy, 'hard-bug-fix', { repo, override }).candidates[0].route, 'astra');
  assert.deepEqual(ids(resolveCandidates(policy, 'quick-edit', { repo, override }).candidates), ['luna']);
  assert.deepEqual(ids(resolveCandidates(policy, 'quick-edit', { repo, override: { ...override, machines: ['mac-studio'] } }).candidates), ['muse', 'luna']);
  assert.deepEqual(ids(resolveCandidates(policy, 'quick-edit', { repo, override: rule('muse') }).candidates), ['luna']);
});

test('unknown repo uses shared policy and an empty file does not erase central rules', () => {
  assert.deepEqual(resolveCandidates(policy, 'architecture', { repo: 'someone/unknown' }).candidates, resolveCandidates(policy, 'architecture').candidates);
  assert.equal(resolveCandidates(policy, 'architecture', { repo: 'srbryers/fathoms-game', override: { policyVersion: 1, rules: [] } }).candidates[0].route, 'astra');
  assert.throws(() => resolveCandidates(policy, 'docs', { repo: 42 }).candidates, /repo must be/);
});

test('pure remote parser normalizes supported GitHub URL forms', () => {
  for (const url of ['git@github.com:Owner/Repo.git', 'https://github.com/Owner/Repo',
    'https://github.com/Owner/Repo.git', 'ssh://git@github.com/Owner/Repo.git',
    'ssh://git@github.com:22/Owner/Repo.git', 'https://github.com/Owner/Repo.git/',
    ' git@github.com:Owner/Repo.git\n']) assert.equal(parseRepoUrl(url), 'owner/repo', url);
  assert.equal(parseRepoUrl('git@github.com:o/repo.with.dots.git'), 'o/repo.with.dots');
  assert.equal(parseRepoUrl('https://github.com/o/repo.git.git'), 'o/repo.git');
});

test('remote parser rejects non-GitHub hosts, local paths and ambiguous paths', () => {
  for (const url of [null, '', 42, '/local/repo', 'git@gitlab.com:o/n.git',
    'https://github.com.evil/o/n.git', 'https://github.com/o',
    'https://github.com/o/n/tree/main', 'https://github.com/o/n?query=1',
    'https://github.com/o/n#fragment', 'https://github.com/o/%6e',
    'http://github.com/o/n', 'git@github.com:o/..', 'git@github.com:o/n extra']) {
    assert.equal(parseRepoUrl(url), null, String(url));
  }
});

test('repoKey injects a local Git call with separate arguments and handles a missing origin', () => {
  const repoDir = '/tmp/repo with spaces; no shell';
  const execFile = (file, args, options) => {
    assert.equal(file, 'git');
    assert.deepEqual(args, ['-C', repoDir, 'remote', 'get-url', 'origin']);
    assert.equal(options.encoding, 'utf8');
    return 'git@github.com:SRBRYERS/Wedding.git\n';
  };
  assert.equal(repoKey(repoDir, { execFile }), 'srbryers/wedding');
  assert.equal(repoKey(repoDir, { execFile: () => { throw Object.assign(new Error('No such remote'), { status: 2 }); } }), null);
  assert.equal(repoKey(repoDir, { execFile: () => 'https://gitlab.com/o/n' }), null);
  assert.throws(() => repoKey(repoDir, { execFile: () => { throw Object.assign(new Error('git missing'), { code: 'ENOENT' }); } }), /git missing/);
});

test('external Prelude routes preserve instructions and approval flags without spawn fields', () => {
  const repo = 'srbryers/prelude-social-skills-coach';
  for (const [kind, id] of [['user-facing-copy', 'gemini-copy'], ['visual-implementation', 'gemini-visual'], ['image-generation', 'openai-image']]) {
    const [candidate] = resolveCandidates(policy, kind, { repo, machine: 'pc' }).candidates;
    assert.equal(candidate.route, id);
    assert.equal(candidate.type, 'external');
    assert.equal(candidate.requiresSpendApproval, true);
    assert.equal(candidate.instruction, policy.routes[id].instruction);
    assert.equal(candidate.vendor, policy.routes[id].vendor);
    assert.equal(candidate.pool, 'metered');
    for (const key of ['provider', 'model', 'reasoning']) assert.equal(candidate[key], null, key);
    assert.deepEqual(candidate.machines, []);
    assert.match(candidate.note, /An author never approves its own change/);
  }
});

test('external routes reject spawn fields, missing instructions and invalid approval flags', () => {
  for (const [key, value, pattern] of [['provider', 'codex', /provider is not supported/],
    ['machines', ['pc'], /machines is not supported/], ['model', 'image-model', /model is not supported/],
    ['instruction', '', /instruction is required/], ['requiresSpendApproval', 'true', /must be boolean/],
    ['pool', 'codex', /require the metered pool/]]) {
    const p = copy(); p.routes['gemini-copy'][key] = value;
    invalid(validatePolicy(p), pattern);
  }
  invalid(validateOverride(rule('gemini-copy', ['user-facing-copy'], { reasoning: 'high' }), policy), /external routes do not accept reasoning/);
});

test('BB route type defaults to bb and unknown types are rejected', () => {
  const p = copy(); delete p.routes.muse.type;
  assert.equal(validatePolicy(p).ok, true);
  assert.equal(resolveCandidates(p, 'quick-edit').candidates[0].type, 'bb');
  p.routes.muse.type = 'unknown';
  invalid(validatePolicy(p), /type must be bb or external/);
});

test('Prelude applies model and reasoning rules, including the independent-review note', () => {
  const repo = 'srbryers/prelude-social-skills-coach';
  for (const [kind, route, reasoning] of [['quick-edit', 'terra', 'medium'], ['simple-bug-fix', 'terra', 'medium'],
    ['bounded-build', 'gpt-5.5', 'medium'], ['multi-step-coding', 'gpt-5.5', 'medium'],
    ['docs', 'luna', 'low'], ['high-risk-review', 'astra', 'high'], ['routine-review', 'astra', 'high'],
    ['architecture', 'astra', 'xhigh'], ['ui-visual', 'astra', 'xhigh']]) {
    const candidate = resolveCandidates(policy, kind, { repo }).candidates[0];
    assert.equal(candidate.route, route, kind);
    assert.equal(candidate.reasoning, reasoning, kind);
    assert.match(candidate.note, /Independent review.*Gate 5/);
  }
});

test('UI Kit wildcard excludes Muse for every kind, even after escalation or a file preference', () => {
  const repo = 'srbryers/ui-kit';
  for (const kind of Object.keys(policy.kinds)) for (const failures of [0, 2]) {
    const candidates = resolveCandidates(policy, kind, { repo, failures }).candidates;
    assert.ok(candidates.length > 0, kind);
    assert.ok(candidates.every(c => c.route !== 'muse'), kind);
    assert.ok(candidates.every(c => c.note.includes('kit-curator gate')), kind);
  }
  assert.deepEqual(ids(resolveCandidates(policy, 'quick-edit', { repo, override: rule('muse') }).candidates), ['luna']);
});

test('file wildcard rules support routes, exclusions and notes; specific routes take priority', () => {
  const override = { policyVersion: 1, rules: [
    { kinds: ['*'], route: 'astra', excludeRoutes: ['muse'], note: 'Shared note.', source: 'AGENTS.md', why: 'Repo default.' },
    { kinds: ['docs'], route: 'luna', note: 'Docs note.', source: 'AGENTS.md', why: 'Docs preference.' },
  ] };
  assert.equal(validateOverride(override, policy).ok, true);
  assert.equal(resolveCandidates(policy, 'quick-edit', { override }).candidates[0].route, 'astra');
  const docs = resolveCandidates(policy, 'docs', { override }).candidates;
  assert.equal(docs[0].route, 'luna');
  assert.ok(docs.every(c => c.route !== 'muse'));
  assert.equal(docs[0].note, 'Shared note. Docs note.');
});

test('rule validation rejects unknown exclusions, mixed wildcards and empty actions', () => {
  invalid(validateOverride(rule('astra', ['docs'], { excludeRoutes: ['typo'] }), policy), /excludeRoutes: unknown id typo/);
  invalid(validateOverride(rule('astra', ['*', 'docs']), policy), /wildcard \* must be used alone/);
  invalid(validateOverride(rule('astra', ['docs'], { note: '' }), policy), /note must be a nonempty string/);
  const override = rule('astra'); delete override.rules[0].route;
  invalid(validateOverride(override, policy), /supply route, excludeRoutes or note/);
});

test('repo arguments normalize case and .git suffix; malformed keys throw', () => {
  const expected = resolveCandidates(policy, 'quick-edit', { repo: 'srbryers/ui-kit' });
  for (const repo of ['SrBryers/UI-Kit', 'SRBRYERS/UI-KIT.GIT']) {
    assert.deepEqual(resolveCandidates(policy, 'quick-edit', { repo }), expected);
  }
  assert.deepEqual(ids(expected.candidates), ['luna']);
  for (const repo of ['', [], 'owner', 'a/b/c', 'https://github.com/o/n', 'o/..', 'o/n?x']) {
    assert.throws(() => resolveCandidates(policy, 'docs', { repo }), /valid owner\/name/);
  }
});

test('rule route and excluded route identifiers must be strings', () => {
  for (const route of [['astra'], { toString: () => 'astra' }, 1, null]) {
    invalid(validateOverride(rule(route), policy), /route must be a string/);
  }
  invalid(validateOverride(rule('astra', ['docs'], { excludeRoutes: [['muse']] }), policy), /entries must be strings/);
  const p = copy(); p.repos['srbryers/wedding'].rules[0].route = ['astra'];
  invalid(validatePolicy(p), /route must be a string/);
});

test('repoKey decodes injected Buffer output', () => {
  assert.equal(repoKey('/unused', { execFile: () => Buffer.from('git@github.com:SrBryers/UI-Kit.git\n') }), 'srbryers/ui-kit');
  assert.equal(parseRepoUrl('git@github.com-work:srbryers/ui-kit.git'), null);
});

test('repo escalation retains marked preference before next-tier candidates', () => {
  const result = resolveCandidates(policy, 'docs', { repo: 'srbryers/prelude-social-skills-coach', failures: 2 });
  assert.deepEqual(ids(result.candidates), ['luna', 'sonnet', 'astra']);
  assert.deepEqual(result.candidates.map(c => [c.source, c.tier, c.fallback, c.escalated]),
    [['repo', 2, false, true], ['tier', 2, true, true], ['tier', 2, true, true]]);
  assert.equal(result.candidates[0].reasoning, 'low');
  const override = { policyVersion: 1, rules: [{ kinds: ['docs'], excludeRoutes: ['sonnet'], source: 'AGENTS.md', why: 'Use another vendor.' }] };
  const filtered = resolveCandidates(policy, 'docs', { repo: 'srbryers/prelude-social-skills-coach', override, failures: 2 });
  assert.deepEqual(ids(filtered.candidates), ['luna', 'astra']);
  assert.ok(filtered.blocked.some(b => b.route === 'sonnet' && /excluded/.test(b.why)));
});

test('candidate shape includes provenance and distinguishes declared fallbacks', () => {
  const result = resolveCandidates(policy, 'quick-edit');
  assert.deepEqual(Object.keys(result).sort(), ['blocked', 'candidates']);
  const keys = ['route', 'type', 'provider', 'model', 'reasoning', 'machines', 'pool', 'vendor', 'tier', 'source', 'fallback', 'escalated', 'reason'];
  assert.deepEqual(Object.keys(result.candidates[0]).sort(), keys.sort());
  assert.equal(result.candidates[0].fallback, false);
  assert.equal(result.candidates[1].fallback, true);
  const external = resolveCandidates(policy, 'user-facing-copy', { repo: 'srbryers/prelude-social-skills-coach' }).candidates[0];
  for (const key of keys) assert.ok(Object.hasOwn(external, key), key);
  assert.equal(external.tier, 1);
  assert.equal(external.source, 'repo');
});

test('blocked explains exclusions, machine limits and source conflicts', () => {
  const pc = resolveCandidates(policy, 'quick-edit', { machine: 'pc' });
  assert.ok(pc.blocked.some(b => b.route === 'muse' && /machine limit/.test(b.why)));
  const empty = resolveCandidates(policy, 'docs', { repo: 'srbryers/fathoms-game', machine: 'mac-studio' });
  assert.deepEqual(empty.candidates, []);
  assert.deepEqual(empty.blocked.map(b => b.route), ['muse', 'luna']);
  const override = rule('astra', ['3d-work'], { reasoning: 'medium' });
  const conflict = resolveCandidates(policy, '3d-work', { repo: 'srbryers/flora-studio', override });
  assert.equal(conflict.candidates[0].source, 'file');
  assert.equal(conflict.candidates[0].reasoning, 'medium');
  assert.ok(conflict.blocked.some(b => b.route === 'astra' && /repo candidate superseded by file/.test(b.why)));
  for (const b of [...pc.blocked, ...empty.blocked, ...conflict.blocked]) assert.deepEqual(Object.keys(b).sort(), ['route', 'why']);
});

test('Claude identity must agree in every direction, including on external routes', () => {
  for (const [field, value] of [['provider', 'pi'], ['pool', 'local'], ['vendor', 'openai'], ['model', 'other']]) {
    const p = copy(); p.routes.opus[field] = value;
    invalid(validatePolicy(p), /Claude requires/);
  }
  for (const [field, value] of [['provider', 'claude-code'], ['pool', 'claude'], ['vendor', 'anthropic'], ['model', 'claude-renamed']]) {
    const p = copy(); p.routes['pi-local'][field] = value;
    invalid(validatePolicy(p), /Claude requires/);
  }
  const p = copy(); p.routes['gemini-copy'].vendor = 'anthropic';
  invalid(validatePolicy(p), /Claude requires/);
});

test('Codex and Muse pool/provider identity is bidirectional', () => {
  for (const [id, field, value, pattern] of [
    ['astra', 'pool', 'local', /codex provider and pool/], ['astra', 'provider', 'pi', /codex provider and pool/],
    ['astra', 'vendor', 'local', /codex provider and pool/], ['pi-local', 'pool', 'codex', /codex provider and pool/],
    ['muse', 'pool', 'local', /acp-muse provider and muse pool/], ['muse', 'provider', 'pi', /acp-muse provider and muse pool/],
    ['pi-local', 'pool', 'muse', /acp-muse provider and muse pool/],
  ]) { const p = copy(); p.routes[id][field] = value; invalid(validatePolicy(p), pattern); }
});

test('contributor is rejected regardless of case, field or hyphen', () => {
  for (const field of ['model', 'provider']) {
    const p = copy(); p.routes.muse[field] = 'MuseContributor';
    invalid(validatePolicy(p), /contributor routes are forbidden/);
  }
  const p = copy(); p.routes.ConTributor = structuredClone(p.routes['gemini-copy']);
  invalid(validatePolicy(p), /contributor routes are forbidden/);
});

test('loaders reject nested and escaped duplicate JSON keys without confusing strings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routing-duplicates-'));
  const path = join(dir, '.model-routing.json');
  try {
    for (const contents of [
      '{"policyVersion":1,"policyVersion":1}',
      '{"rules":[{"route":"astra","route":"luna"}]}',
      '{"rules":[{"route":"astra","rout\\u0065":"luna"}]}',
      '{"a":{"x":1,"x":2}}',
    ]) {
      writeFileSync(path, contents);
      assert.throws(() => loadPolicy(path), /Duplicate JSON key/);
      assert.throws(() => loadOverride(dir), /Duplicate JSON key/);
    }
    const valid = { policyVersion: 1, rules: [
      { kinds: ['docs'], route: 'luna', source: 'AGENTS.md', why: 'Text with "route": and {,} and \\ escapes.' },
      { kinds: ['quick-edit'], route: 'luna', source: 'AGENTS.md', why: 'Same keys in different objects are valid.' },
    ] };
    writeFileSync(path, JSON.stringify(valid));
    assert.deepEqual(loadOverride(dir), valid);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('kind routes must match tier membership or explicitly justify cross-tier choices', () => {
  const p = copy(); p.kinds.docs.candidates = ['astra'];
  invalid(validatePolicy(p), /routes must belong to tier 1/);
  p.kinds.docs.crossTier = true;
  invalid(validatePolicy(p), /crossTierReason is required/);
  p.kinds.docs.crossTierReason = 'A deliberate exception.';
  assert.equal(validatePolicy(p).ok, true);
  const fallback = copy(); fallback.kinds.docs.fallbacks = ['opus'];
  invalid(validatePolicy(fallback), /routes must belong to tier 1/);
  const external = copy(); external.tiers['1'].candidates = ['gemini-copy'];
  invalid(validatePolicy(external), /external route gemini-copy is not allowed in a tier/);
});

test('rules cannot exclude every applicable route, including combined wildcard exclusions', () => {
  const override = { policyVersion: 1, rules: [{ kinds: ['docs'], excludeRoutes: ['muse', 'luna'], source: 'AGENTS.md', why: 'Invalid: no route remains.' }] };
  invalid(validateOverride(override, policy), /exclusions remove every route for docs/);
  override.rules[0].excludeRoutes = Object.keys(policy.routes);
  invalid(validateOverride(override, policy), /exclusions remove every route/);
  override.rules[0].excludeRoutes = ['luna'];
  override.rules.push({ kinds: ['*'], excludeRoutes: ['muse'], source: 'AGENTS.md', why: 'Combine exclusions.' });
  invalid(validateOverride(override, policy), /exclusions remove every route for docs/);
});

test('Sonnet accepts xhigh but rejects max', () => {
  const override = rule('sonnet', ['docs'], { reasoning: 'xhigh' });
  assert.equal(validateOverride(override, policy).ok, true);
  assert.equal(resolveCandidates(policy, 'docs', { override }).candidates[0].reasoning, 'xhigh');
  override.rules[0].reasoning = 'max';
  invalid(validateOverride(override, policy), /exceeds cap xhigh/);
});

test('a superseded wildcard route cannot rescue an override that excludes every candidate', () => {
  const override = { policyVersion: 1, rules: [
    { kinds: ['*'], route: 'astra', source: 'AGENTS.md', why: 'Default.' },
    { kinds: ['docs'], route: 'luna', excludeRoutes: ['muse', 'luna'], source: 'AGENTS.md', why: 'Invalid specific rule.' },
  ] };
  invalid(validateOverride(override, policy), /exclusions remove every route for docs/);
});
