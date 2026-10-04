/** Test helper: the public policy plus a generic repo overlay, so repo-rule tests stay offline and name-free. */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEffectivePolicy } from '../policy-local.mjs';

export const testOverlayFile = new URL('./policy.local.test.json', import.meta.url);

/** Write the overlay where `env`'s config dir expects it; returns the env. */
export function installTestOverlay(home) {
  const dir = join(home, '.config', 'model-routing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'policy.local.json'), readFileSync(testOverlayFile));
  return { HOME: home };
}

export function loadPolicyWithTestRepos() {
  return loadEffectivePolicy({ env: { HOME: '/nonexistent' },
    readFile: () => readFileSync(testOverlayFile, 'utf8') }).policy;
}
