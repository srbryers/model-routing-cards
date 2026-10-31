/** Codex latest intent resolves only to catalogue slugs or the standing fallback. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EXCLUDED_FAMILIES = new Set(['luna']);
export const latestFamilyAllowed = family => typeof family === 'string'
  && /^[a-z][a-z0-9]*$/.test(family) && !EXCLUDED_FAMILIES.has(family);

/** Numeric components avoid lexical ordering and preserve arbitrarily large versions. */
function version(slug, family) {
  if (typeof slug !== 'string' || !slug.endsWith(`-${family}`)) return null;
  const number = slug.slice(0, -family.length - 1);
  if (!/^gpt-\d+(?:\.\d+)*$/.test(number)) return null;
  return number.slice(4).split('.').map(part => BigInt(part));
}
function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0n, right = b[i] ?? 0n;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

/** Pure: malformed catalogues and excluded families retain the standing identity. */
export function resolveLatest(catalogue, family, standingModel) {
  const result = { family, latest: true, standingModel, resolvedModel: standingModel,
    source: 'fallback', fallback: true };
  if (!latestFamilyAllowed(family) || !Array.isArray(catalogue?.models)) return result;
  let best = null;
  for (const entry of catalogue.models) {
    const candidate = version(entry?.slug, family);
    if (!candidate) continue;
    const order = best ? compare(candidate, best) : 1;
    if (order > 0 || (order === 0 && entry.slug === standingModel)) {
      best = candidate;
      result.resolvedModel = entry.slug;
    }
  }
  if (best) Object.assign(result, { source: 'catalogue', fallback: false });
  return result;
}

/** CLI boundary: read failures and invalid JSON become the pure resolver's fallback. */
export function loadCatalogue({ env = process.env, path = join(env.HOME || homedir(), '.codex', 'models_cache.json'),
  readFile = readFileSync } = {}) {
  try { return JSON.parse(readFile(path, 'utf8')); }
  catch { return null; }
}
