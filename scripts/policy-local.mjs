/**
 * The user's local policy overlay: `$XDG_CONFIG_HOME/model-routing/policy.local.json`.
 *
 * It adds personal repo rules and text to the public policy. It cannot add routes or
 * kinds, or change tiers, quota or the hard rules. The merged result goes through the
 * same validator as the public file.
 *
 * ⚠ A bad overlay is an error, never ignored: it changes routing, so silently dropping
 * it would send work to the wrong model. (The local.json pattern of disabling only what
 * a bad file affects does not fit: a repo rule can touch any route.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, validatePolicy, parseUniqueJson, freeze, PUBLIC_POLICY } from './policy.mjs';
import { configDir } from './local-config.mjs';

export const OVERLAY_FILE = 'policy.local.json';
const SECTIONS = ['policyVersion', 'repos', 'routes', 'kinds', 'instructions'];

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => object(o) && Object.hasOwn(o, k);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;

export const overlayPath = (env = process.env) => join(configDir(env), OVERLAY_FILE);

/** Structural checks, then the merged policy through `validatePolicy`. */
export function validateOverlay(overlay, policy) {
  const errors = [];
  if (!object(overlay)) return { ok: false, errors: ['overlay must be a JSON object'] };
  for (const key of Object.keys(overlay)) {
    if (!SECTIONS.includes(key)) errors.push(`${key} is not supported; an overlay may set only ${SECTIONS.join(', ')}`);
  }
  if (overlay.policyVersion !== policy.policyVersion) errors.push(`policyVersion must be ${policy.policyVersion}`);
  const section = (name, check) => {
    if (!has(overlay, name)) return;
    if (!object(overlay[name])) { errors.push(`${name} must be an object`); return; }
    for (const [id, value] of Object.entries(overlay[name])) check(id, value, `${name}.${id}`);
  };
  const known = (collection, id, path) => {
    if (has(policy[collection], id)) return true;
    errors.push(`${path}: unknown ${collection === 'routes' ? 'route' : 'kind'}; an overlay cannot add one`);
    return false;
  };
  const onlyField = (value, field, path) => {
    if (!object(value)) { errors.push(`${path} must be an object`); return false; }
    for (const key of Object.keys(value)) if (key !== field) errors.push(`${path}.${key} is not supported; only ${field} may be set`);
    if (!nonempty(value[field])) errors.push(`${path}.${field} must be a nonempty string`);
    return true;
  };
  section('repos', () => {}); // contents are validated with the merged policy
  section('routes', (id, value, path) => {
    if (!known('routes', id, path) || !onlyField(value, 'note', path)) return;
    if (policy.routes[id].type === 'external') errors.push(`${path}: external routes take an instruction override, not a note`);
  });
  section('kinds', (id, value, path) => { if (known('kinds', id, path)) onlyField(value, 'description', path); });
  section('instructions', (id, value, path) => {
    if (!known('routes', id, path)) return;
    if (policy.routes[id].type !== 'external') errors.push(`${path}: only external routes have an instruction`);
    if (!nonempty(value)) errors.push(`${path} must be a nonempty string`);
  });
  if (errors.length) return { ok: false, errors };
  return validatePolicy(applyOverlay(policy, overlay));
}

/** Pure merge of an already structurally valid overlay. Local repo entries replace public ones whole. */
export function applyOverlay(policy, overlay) {
  const merged = structuredClone(policy);
  if (has(overlay, 'repos') && object(overlay.repos)) merged.repos = { ...merged.repos, ...structuredClone(overlay.repos) };
  for (const [id, { note }] of Object.entries(overlay.routes ?? {})) merged.routes[id].note = note;
  for (const [id, { description }] of Object.entries(overlay.kinds ?? {})) merged.kinds[id].description = description;
  for (const [id, instruction] of Object.entries(overlay.instructions ?? {})) merged.routes[id].instruction = instruction;
  return merged;
}

/** What the overlay touches, for `policy show`. */
function effects(overlay, publicPolicy) {
  const keys = name => Object.keys(overlay[name] ?? {});
  return { repos: keys('repos').map(repo => ({ repo, replacesPublic: has(publicPolicy.repos, repo) })),
    routeNotes: keys('routes'), kindDescriptions: keys('kinds'), instructions: keys('instructions') };
}

/**
 * The policy every command uses: public policy plus the local overlay, validated and frozen.
 * Missing overlay file is fine. Unreadable, malformed or invalid throws a TypeError naming the file.
 */
export function loadEffectivePolicy({ env = process.env, readFile = readFileSync, publicPath = PUBLIC_POLICY } = {}) {
  const base = loadPolicy(publicPath);
  const file = overlayPath(env);
  const sources = { policy: publicPath instanceof URL ? fileURLToPath(publicPath) : String(publicPath),
    overlay: { file, loaded: false } };
  let text;
  try { text = readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { policy: base, sources, effects: effects({}, base) };
    throw new TypeError(`${file}: local policy overlay could not be read (${error.code ?? error.message})`);
  }
  let overlay;
  try { overlay = parseUniqueJson(text); }
  catch (error) { throw new TypeError(`${file}: invalid local policy overlay: not valid JSON (${error.message})`); }
  const result = validateOverlay(overlay, base);
  if (!result.ok) throw new TypeError(`${file}: invalid local policy overlay:\n${result.errors.map(e => `  - ${e}`).join('\n')}`);
  sources.overlay.loaded = true;
  return { policy: freeze(applyOverlay(base, overlay)), sources, effects: effects(overlay, base) };
}

const tokens = text => text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? [];

/**
 * True when `oldText` differs from `newText` only by proper names that the public text
 * replaces with "the user". This is how the exporter finds text that named a person.
 */
function namesPerson(oldText, newText) {
  if (oldText === newText) return false;
  const before = tokens(oldText);
  const after = tokens(newText);
  const inBefore = new Set(before);
  const inAfter = new Set(after);
  const removed = before.filter(word => !inAfter.has(word));
  const added = after.filter(word => !inBefore.has(word));
  return removed.length > 0 && removed.every(word => /^\p{Lu}/u.test(word))
    && added.every(word => ['the', 'user', "user's", 'user’s'].includes(word.toLowerCase()));
}

/**
 * Build an overlay from an older policy file: all its repo entries, plus route notes,
 * kind descriptions and external instructions that named a person and now differ from
 * the current public policy. Pure; the caller prints the result.
 */
export function exportLocal(oldPolicy, currentPolicy) {
  if (!object(oldPolicy) || !object(oldPolicy.repos)) throw new TypeError('--from must be a routing policy file with a repos object');
  const overlay = { policyVersion: currentPolicy.policyVersion };
  if (Object.keys(oldPolicy.repos).length) overlay.repos = structuredClone(oldPolicy.repos);
  const text = (collection, field, target, wrap = value => value) => {
    for (const [id, old] of Object.entries(object(oldPolicy[collection]) ? oldPolicy[collection] : {})) {
      const current = currentPolicy[collection][id];
      if (!current || !nonempty(old?.[field]) || !nonempty(current[field])) continue;
      if (collection === 'routes' && (old.type === 'external') !== (field === 'instruction')) continue;
      if (namesPerson(old[field], current[field])) (overlay[target] ??= {})[id] = wrap(old[field]);
    }
  };
  text('routes', 'note', 'routes', note => ({ note }));
  text('kinds', 'description', 'kinds', description => ({ description }));
  text('routes', 'instruction', 'instructions');
  const result = validateOverlay(overlay, currentPolicy);
  if (!result.ok) throw new TypeError(`Exported overlay is not valid against the current policy:\n${result.errors.map(e => `  - ${e}`).join('\n')}`);
  return overlay;
}
