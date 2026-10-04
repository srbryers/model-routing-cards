import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';

const localConfig = fileURLToPath(new URL('../.jev.local.json', import.meta.url));

/** Resolve only when executing a judgment; importing the adapter stays credential-free.
 * A local path points to the existing key store, so worktrees do not need key copies. */
export function readJevKey({ env = process.env, configFile = localConfig,
  xdgConfigFile = resolve(env.XDG_CONFIG_HOME || resolve(env.HOME || homedir(), '.config'), 'model-routing', 'jev.local.json') } = {}) {
  if (env.TYPESAFE_API_KEY?.trim()) return env.TYPESAFE_API_KEY.trim();
  let envFile = env.TYPESAFE_ENV_FILE;
  const selectedConfig = !envFile && [configFile, xdgConfigFile].find(file => existsSync(file));
  if (selectedConfig) {
    let config;
    try { config = JSON.parse(readFileSync(selectedConfig, 'utf8')); }
    catch { throw new Error('Jev local config could not be read as JSON; check its envFile setting.'); }
    if (typeof config?.envFile !== 'string' || !config.envFile.trim()) {
      throw new Error('Jev local config needs an envFile path.');
    }
    envFile = resolve(dirname(selectedConfig), config.envFile);
  }
  if (envFile) {
    let key;
    try { key = parseEnv(readFileSync(envFile, 'utf8')).TYPESAFE_API_KEY?.trim(); }
    catch { throw new Error('Configured Jev envFile could not be read or parsed.'); }
    if (key) return key;
    throw new Error('Configured Jev env file has no non-empty TYPESAFE_API_KEY.');
  }
  throw new Error('Set TYPESAFE_API_KEY, TYPESAFE_ENV_FILE, or envFile in the repo-local or XDG Jev config.');
}
