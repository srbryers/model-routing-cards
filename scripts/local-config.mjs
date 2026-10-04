import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

/** Directory for user-managed files: `$XDG_CONFIG_HOME/model-routing`, default `~/.config/model-routing`. */
export const configDir = (env = process.env) =>
  resolve(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'model-routing');

export function loadLocalConfig(policy, { env = process.env, readFile = readFileSync } = {}) {
  const file = join(configDir(env), 'local.json');
  const unavailable = message => ({ routes: {}, error: `${file}: ${message}; local routes unavailable` });
  let contents;
  try { contents = readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { routes: {} };
    return unavailable('could not be read');
  }
  let config;
  // ⚠ Parser errors can echo file contents. Report the config path, never its contents.
  try { config = JSON.parse(contents); }
  catch { return unavailable('must be valid JSON'); }
  const result = validateLocalConfig(config, policy);
  if (!result.ok) return unavailable('invalid local model configuration');
  return config;
}

/** For `policy show`: where local.json is and whether it loaded. */
export function localConfigStatus(policy, { env = process.env, readFile = readFileSync } = {}) {
  const file = join(configDir(env), 'local.json');
  const { error } = loadLocalConfig(policy, { env, readFile });
  if (error) return { file, state: 'error', error };
  try { readFile(file, 'utf8'); } catch { return { file, state: 'absent' }; }
  return { file, state: 'loaded' };
}
