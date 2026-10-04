import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Local configuration can supply model IDs, never rewrite routing policy. */
export function validateLocalConfig(config, policy) {
  const errors = [];
  if (!object(config) || Object.keys(config).some(key => key !== 'routes') || !object(config.routes)) {
    return { ok: false, errors: ['local.json must contain only a routes object'] };
  }
  for (const [id, entry] of Object.entries(config.routes)) {
    if (!Object.hasOwn(policy.routes, id) || policy.routes[id].modelFrom !== 'local') {
      errors.push(`local.json route ${id} is not marked modelFrom: local`);
    }
    if (!object(entry) || Object.keys(entry).length !== 1 || !Object.hasOwn(entry, 'model')
      || typeof entry.model !== 'string' || !entry.model.trim()) {
      errors.push(`local.json route ${id} must contain only a nonempty model`);
    } else if (/contributor/i.test(entry.model)) errors.push(`local.json route ${id}: contributor models are forbidden`);
  }
  return { ok: !errors.length, errors };
}

export function loadLocalConfig(policy, { env = process.env, readFile = readFileSync } = {}) {
  const file = join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'model-routing', 'local.json');
  let contents;
  try { contents = readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { routes: {} };
    throw new Error('local.json could not be read');
  }
  let config;
  // ⚠ A parse error can echo a private model path; report only the config name.
  try { config = JSON.parse(contents); }
  catch { throw new TypeError('local.json must be valid JSON'); }
  const result = validateLocalConfig(config, policy);
  if (!result.ok) throw new TypeError(result.errors.join('\n'));
  return config;
}
