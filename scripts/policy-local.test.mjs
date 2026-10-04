import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, validatePolicy, validateOverride, resolveCandidates, machineIds } from './policy.mjs';
import { loadEffectivePolicy, validateOverlay, exportLocal, overlayPath } from './policy-local.mjs';
import { main } from '../bin/model-routing.mjs';

const publicPolicy = loadPolicy();
const oldPolicy = loadPolicy(new URL('./fixtures/policy.pre-overlay.json', import.meta.url));
const example = JSON.parse(readFileSync(new URL('../policy/examples/policy.local.example.json', import.meta.url), 'utf8'));

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-local-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(dir, contents) {
  const file = overlayPath({ HOME: dir });
  mkdirSync(join(dir, '.config', 'model-routing'), { recursive: true });
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}
const rejects = (overlay, pattern) => {
  const result = validateOverlay(overlay, publicPolicy);
  assert.equal(result.ok, false, JSON.stringify(overlay));
  assert.ok(result.errors.some(e => pattern.test(e)), JSON.stringify(result.errors));
};

test('the public policy alone validates, holds no repo rules and names no person', () => {
  assert.deepEqual(validatePolicy(publicPolicy), { ok: true, errors: [] });
  assert.deepEqual(publicPolicy.repos, {});
  // Character classes keep this file clear of the grep that guards the public tree.
  const personal = /s[e]bastian|s[r]bryers\/|\/Users\/|~\/\.claude/i;
  assert.doesNotMatch(readFileSync(new URL('../policy/policy.json', import.meta.url), 'utf8'), personal);
});

test('a missing overlay is not an error and leaves the public policy unchanged', t => {
  const result = loadEffectivePolicy({ env: { HOME: home(t) } });
  assert.deepEqual(result.policy, publicPolicy);
  assert.equal(result.sources.overlay.loaded, false);
  assert.match(result.sources.overlay.file, /\.config\/model-routing\/policy\.local\.json$/);
});
test('XDG_CONFIG_HOME wins over HOME', () => {
  assert.equal(overlayPath({ HOME: '/h', XDG_CONFIG_HOME: '/x' }), '/x/model-routing/policy.local.json');
  assert.equal(overlayPath({ HOME: '/h' }), '/h/.config/model-routing/policy.local.json');
});

test('the example overlay validates and every part of it applies', t => {
  assert.deepEqual(validateOverlay(example, publicPolicy), { ok: true, errors: [] });
  const { policy, sources, effects } = loadEffectivePolicy({ env: { HOME: '/unused' }, readFile: () => JSON.stringify(example) });
  assert.equal(sources.overlay.loaded, true);
  assert.deepEqual(policy.repos['your-org/your-repo'], example.repos['your-org/your-repo']);
  assert.equal(policy.routes.astra.note, example.routes.astra.note);
  assert.equal(policy.kinds.docs.description, example.kinds.docs.description);
  assert.equal(policy.routes['gemini-copy'].instruction, example.instructions['gemini-copy']);
  assert.deepEqual(effects, { repos: [{ repo: 'your-org/your-repo', replacesPublic: false }],
    routeNotes: ['astra'], kindDescriptions: ['docs'], instructions: ['gemini-copy'] });
  // Only the named fields changed.
  assert.equal(policy.kinds.docs.tier, publicPolicy.kinds.docs.tier);
  assert.deepEqual(policy.quota, publicPolicy.quota);
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.repos['your-org/your-repo']));
  const rule = resolveCandidates(policy, 'bounded-build', { repo: 'your-org/your-repo' }).candidates[0];
  assert.equal(rule.route, 'luna'); assert.equal(rule.source, 'repo');
  t.diagnostic('example repo rule applied');
});

test('an overlay cannot add routes or kinds, or change tiers, quota, hard rules or routing fields', () => {
  rejects({ policyVersion: 1, routes: { 'new-route': { note: 'x' } } }, /routes\.new-route: unknown route; an overlay cannot add one/);
  rejects({ policyVersion: 1, kinds: { 'new-kind': { description: 'x' } } }, /kinds\.new-kind: unknown kind; an overlay cannot add one/);
  rejects({ policyVersion: 1, instructions: { 'new-route': 'x' } }, /instructions\.new-route: unknown route/);
  rejects({ policyVersion: 1, quota: { ...publicPolicy.quota, overridesBeatHardStops: true } }, /quota is not supported/);
  rejects({ policyVersion: 1, tiers: publicPolicy.tiers }, /tiers is not supported/);
  rejects({ policyVersion: 1, machines: {} }, /machines is not supported/);
  rejects({ policyVersion: 1, review: { differentVendor: false } }, /review is not supported/);
  rejects({ policyVersion: 1, routes: { sonnet: { maxReasoning: 'max' } } }, /routes\.sonnet\.maxReasoning is not supported/);
  rejects({ policyVersion: 1, routes: { sonnet: { note: 'ok', pool: 'codex' } } }, /routes\.sonnet\.pool is not supported/);
  rejects({ policyVersion: 1, routes: { sonnet: { model: 'other' } } }, /routes\.sonnet\.model is not supported/);
  rejects({ policyVersion: 1, kinds: { docs: { description: 'ok', tier: 3 } } }, /kinds\.docs\.tier is not supported/);
  rejects({ policyVersion: 1, kinds: { docs: { candidates: ['astra'] } } }, /kinds\.docs\.candidates is not supported/);
  rejects({ policyVersion: 1, kinds: { docs: { description: ' ' } } }, /kinds\.docs\.description must be a nonempty string/);
  rejects({ policyVersion: 1, routes: { 'gemini-copy': { note: 'x' } } }, /external routes take an instruction override/);
  rejects({ policyVersion: 1, instructions: { sonnet: 'x' } }, /only external routes have an instruction/);
  rejects({ policyVersion: 1, instructions: { 'gemini-copy': '' } }, /instructions\.gemini-copy must be a nonempty string/);
  rejects({ policyVersion: 2 }, /policyVersion must be 1/);
  rejects({}, /policyVersion must be 1/);
  rejects([], /must be a JSON object/);
  rejects({ policyVersion: 1, repos: [] }, /repos must be an object/);
});
test('overlay repo rules go through the repo validator', () => {
  rejects({ policyVersion: 1, repos: { 'Not A Repo': { rules: [] } } }, /invalid GitHub repo key/);
  rejects({ policyVersion: 1, repos: { 'a/b': { rules: [{ kinds: ['docs'], route: 'typo', source: 's', why: 'w' }] } } }, /repos\.a\/b.*unknown route id typo/);
  rejects({ policyVersion: 1, repos: { 'a/b': { rules: [{ kinds: ['skill-workflow'], route: 'muse', source: 's', why: 'w' }] } } }, /repos\.a\/b.*excluded/);
  rejects({ policyVersion: 1, repos: { 'a/b': { rules: [], extra: 1 } } }, /repos\.a\/b.*extra is not supported/);
});

test('an overlay never edits the policy it was merged into', () => {
  const before = structuredClone(publicPolicy);
  loadEffectivePolicy({ env: { HOME: '/unused' }, readFile: () => JSON.stringify(example) });
  assert.deepEqual(publicPolicy, before);
});

// ---- Equivalence with the policy that held the personal rules ----

const repos = Object.keys(oldPolicy.repos);
const kinds = Object.keys(oldPolicy.kinds);
const machines = [undefined, ...machineIds(oldPolicy)];

test('the old policy file has the five personal repos this change moves', () => {
  assert.equal(repos.length, 5);
  assert.ok(repos.every(repo => !(repo in publicPolicy.repos)));
});
test('public policy plus the exported overlay resolves exactly like the old policy', () => {
  const overlay = exportLocal(oldPolicy, publicPolicy);
  const { policy } = loadEffectivePolicy({ env: { HOME: '/unused' }, readFile: () => JSON.stringify(overlay) });
  let compared = 0;
  for (const repo of [null, ...repos]) for (const kind of kinds) for (const machine of machines) for (const failures of [0, 2]) {
    for (const extra of [{}, { reviewFallbacks: true }, { meteredFallbacks: true }]) {
      const options = { repo, machine, failures, ...extra, localConfig: { routes: { 'pi-local': { model: 'local-test-model' } } } };
      assert.deepEqual(resolveCandidates(policy, kind, options), resolveCandidates(oldPolicy, kind, options),
        JSON.stringify({ kind, ...options }));
      compared++;
    }
  }
  assert.equal(compared, 6 * kinds.length * machines.length * 2 * 3);
});
test('export-local from the old file restores the old policy exactly, text included', () => {
  const overlay = exportLocal(oldPolicy, publicPolicy);
  assert.deepEqual(overlay.repos, oldPolicy.repos);
  // The one person-naming text in the old public file is the external route instruction.
  assert.deepEqual(Object.keys(overlay).sort(), ['instructions', 'policyVersion', 'repos']);
  assert.deepEqual(overlay.instructions, { 'gemini-copy': oldPolicy.routes['gemini-copy'].instruction });
  const { policy } = loadEffectivePolicy({ env: { HOME: '/unused' }, readFile: () => JSON.stringify(overlay) });
  assert.deepEqual(policy, oldPolicy);
  assert.notEqual(publicPolicy.routes['gemini-copy'].instruction, oldPolicy.routes['gemini-copy'].instruction);
});
test('export-local carries only person-naming text, not other differences from the current policy', () => {
  const changed = structuredClone(oldPolicy);
  changed.kinds.docs.description = 'A newer public description of documentation work.';
  changed.routes.luna.note = 'Ask Dana about quota.';
  const current = structuredClone(publicPolicy);
  current.routes.luna.note = 'Ask the user about quota.';
  const overlay = exportLocal(changed, current);
  assert.equal(overlay.kinds, undefined);
  assert.deepEqual(overlay.routes, { luna: { note: 'Ask Dana about quota.' } });
});
test('export-local needs a policy with repos and checks its own output', () => {
  assert.throws(() => exportLocal({}, publicPolicy), /repos object/);
  const broken = structuredClone(oldPolicy);
  broken.repos[repos[0]].rules[0].route = 'removed-route';
  assert.throws(() => exportLocal(broken, publicPolicy), /not valid against the current policy[\s\S]*unknown route id removed-route/);
  const none = exportLocal({ repos: {} }, publicPolicy);
  assert.deepEqual(none, { policyVersion: 1 });
});

// ---- Precedence: repo file > local overlay > public policy ----

test('precedence: repo .model-routing.json, then local overlay, then public policy', t => {
  const entry = route => ({ rules: [{ kinds: ['bounded-build'], route, source: 'AGENTS.md', why: `${route} here` }] });
  const dir = home(t);
  const publicFile = join(dir, 'public.json');
  writeFileSync(publicFile, JSON.stringify({ ...publicPolicy, repos: {
    'org/app': { machines: ['mac-studio'], ...entry('luna') },
    'org/only-public': entry('luna') } }));
  const env = { HOME: dir };
  const file = { policyVersion: 1, rules: [{ kinds: ['bounded-build'], route: 'sonnet', source: 'repo', why: 'file wins' }] };
  const first = policy => resolveCandidates(policy, 'bounded-build', { repo: 'org/app' }).candidates[0];

  // 1. Public policy alone.
  let loaded = loadEffectivePolicy({ env, publicPath: publicFile });
  assert.equal(loaded.sources.overlay.loaded, false);
  assert.deepEqual([first(loaded.policy).route, first(loaded.policy).source], ['luna', 'repo']);

  // 2. The local entry replaces the public entry for the same key, as a whole.
  write(dir, { policyVersion: 1, repos: { 'org/app': entry('astra') } });
  loaded = loadEffectivePolicy({ env, publicPath: publicFile });
  assert.deepEqual(loaded.effects.repos, [{ repo: 'org/app', replacesPublic: true }]);
  assert.equal(first(loaded.policy).route, 'astra');
  assert.equal(loaded.policy.repos['org/app'].machines, undefined, 'public machines do not leak into a replaced entry');
  assert.equal(resolveCandidates(loaded.policy, 'bounded-build', { repo: 'org/only-public' }).candidates[0].route, 'luna');

  // 3. The repo's own file beats both, and the overlay is still the fallback behind it.
  const withFile = resolveCandidates(loaded.policy, 'bounded-build', { repo: 'org/app', override: file }).candidates;
  assert.deepEqual([withFile[0].route, withFile[0].source], ['sonnet', 'file']);
  assert.ok(withFile.some(c => c.route === 'astra' && c.fallback), 'overlay rule stays as a fallback');
  assert.deepEqual(validateOverride(file, loaded.policy), { ok: true, errors: [] });
});

// ---- Failure handling ----

test('a malformed or invalid overlay is an error that names the file', t => {
  const dir = home(t);
  const env = { HOME: dir };
  const file = overlayPath(env);
  for (const [contents, pattern] of [
    ['{ not json', /not valid JSON/],
    ['{"policyVersion":1,"repos":{},"repos":{}}', /not valid JSON.*Duplicate JSON key/],
    [JSON.stringify({ policyVersion: 1, routes: { nope: { note: 'x' } } }), /routes\.nope: unknown route/],
    [JSON.stringify({ policyVersion: 1, quota: {} }), /quota is not supported/],
    [JSON.stringify({ policyVersion: 1, repos: { 'a/b': { rules: [{ kinds: ['docs'], route: 'typo', source: 's', why: 'w' }] } } }), /unknown route id typo/],
  ]) {
    write(dir, contents);
    assert.throws(() => loadEffectivePolicy({ env }), error => {
      assert.ok(error.message.startsWith(`${file}: invalid local policy overlay`), error.message);
      assert.match(error.message, pattern);
      return true;
    });
  }
  assert.throws(() => loadEffectivePolicy({ env, readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }),
    new RegExp(`${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: local policy overlay could not be read \\(EACCES\\)`));
});

// ---- CLI ----

function cli(t, args, { overlay, extra = {} } = {}) {
  const dir = home(t);
  if (overlay !== undefined) write(dir, overlay);
  const out = [];
  const err = [];
  const deps = { env: { HOME: dir }, stdout: text => out.push(text), stderr: text => err.push(text), stateDir: join(dir, 'state'),
    repoKey: () => null, loadOverride: () => null, readQuota: () => null, now: '2026-10-04T15:35:00Z', cwd: dir, ...extra };
  return main(args, deps).then(code => ({ code, out: out.join(''), err: err.join(''), dir }));
}

test('pick exits 2 with the overlay path when the overlay is invalid, and pick uses a valid overlay', async t => {
  const bad = await cli(t, ['pick', '--kind', 'docs', '--no-quota', '--json'], { overlay: { policyVersion: 1, routes: { nope: { note: 'x' } } } });
  assert.equal(bad.code, 2);
  assert.match(bad.err, new RegExp(`${bad.dir}/\\.config/model-routing/policy\\.local\\.json: invalid local policy overlay`));
  assert.match(bad.err, /routes\.nope: unknown route/);
  assert.equal(bad.out, '');

  const good = await cli(t, ['pick', '--kind', 'bounded-build', '--no-quota', '--json'],
    { overlay: { policyVersion: 1, repos: { 'org/app': { rules: [{ kinds: ['bounded-build'], route: 'luna', source: 'AGENTS.md', why: 'Luna here.' }] } } },
      extra: { repoKey: () => 'org/app' } });
  assert.equal(good.code, 0);
  assert.equal(JSON.parse(good.out).route, 'luna');
  assert.match(JSON.parse(good.out).why.join(' '), /policy repo org\/app AGENTS\.md: Luna here\./);
});
test('limit and outcomes also refuse an invalid overlay', async t => {
  for (const args of [['limit', 'luna'], ['outcomes']]) {
    const result = await cli(t, args, { overlay: '{ nope' });
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.err, /policy\.local\.json: invalid local policy overlay: not valid JSON/);
  }
});

test('policy show reports the sources and what the overlay changes', async t => {
  const plain = await cli(t, ['policy', 'show'], { overlay: example });
  assert.equal(plain.code, 0);
  assert.match(plain.out, /Policy: .*policy\/policy\.json/);
  assert.match(plain.out, /policy\.local\.json \(loaded\)/);
  assert.match(plain.out, /local\.json \(not found\)/);
  assert.match(plain.out, /repo rules: your-org\/your-repo\n/);
  assert.match(plain.out, /route notes: astra/);
  assert.match(plain.out, /kind descriptions: docs/);
  assert.match(plain.out, /instruction overrides: gemini-copy/);

  const json = await cli(t, ['policy', 'show', '--json'], { overlay: example });
  const shown = JSON.parse(json.out);
  assert.equal(shown.sources.overlay.loaded, true);
  assert.equal(shown.sources.localModels.state, 'absent');
  assert.deepEqual(Object.keys(shown.policy.repos), ['your-org/your-repo']);
  assert.equal(shown.policy.kinds.docs.description, example.kinds.docs.description);

  const none = await cli(t, ['policy', 'show', '--json']);
  assert.equal(JSON.parse(none.out).sources.overlay.loaded, false);
  assert.deepEqual(JSON.parse(none.out).policy.repos, {});
  assert.match((await cli(t, ['policy', 'show'])).out, /policy\.local\.json \(not found\)/);
});
test('policy show fails on an invalid overlay and reports an unusable local.json', async t => {
  const bad = await cli(t, ['policy', 'show'], { overlay: { policyVersion: 1, tiers: {} } });
  assert.equal(bad.code, 2); assert.match(bad.err, /tiers is not supported/);
  const dir = home(t);
  mkdirSync(join(dir, '.config', 'model-routing'), { recursive: true });
  writeFileSync(join(dir, '.config', 'model-routing', 'local.json'), '{ nope');
  const out = [];
  assert.equal(await main(['policy', 'show', '--json'], { env: { HOME: dir }, stdout: text => out.push(text) }), 0);
  assert.equal(JSON.parse(out.join('')).sources.localModels.state, 'error');
});

test('policy export-local prints the old repo rules and writes nothing', async t => {
  const result = await cli(t, ['policy', 'export-local', '--from', new URL('./fixtures/policy.pre-overlay.json', import.meta.url).pathname]);
  assert.equal(result.code, 0);
  const overlay = JSON.parse(result.out);
  assert.deepEqual(overlay, exportLocal(oldPolicy, publicPolicy));
  assert.deepEqual(validateOverlay(overlay, publicPolicy), { ok: true, errors: [] });
  assert.equal(result.err, 'exported 5 repos, 1 instructions\n');
  assert.equal(result.out.endsWith('}\n'), true);
  assert.throws(() => readFileSync(overlayPath({ HOME: result.dir })), { code: 'ENOENT' });
});
test('policy export-local and show reject bad usage with code 2', async t => {
  for (const args of [['policy'], ['policy', 'nope'], ['policy', 'show', 'extra'], ['policy', 'show', '--from', 'x.json'],
    ['policy', 'export-local'], ['policy', 'export-local', '--from', ' '], ['policy', 'export-local', '--from', '/nonexistent/old.json'],
    ['policy', 'export-local', '--from', new URL('./fixtures/quota.json', import.meta.url).pathname]]) {
    const result = await cli(t, args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.out, '');
  }
  const json = await cli(t, ['policy', 'export-local', '--json', '--from', 'x']);
  assert.equal(json.code, 2); assert.match(json.err, /always prints JSON/);
});
