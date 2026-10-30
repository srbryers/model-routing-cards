/** Rebuild static cards inside this repo only. No credentials or provider calls. */
import { writeFileSync } from 'node:fs';
import { buildCard } from './card.mjs';
import { profile, rolePolicy, hash, validateFloraCards } from './flora.mjs';
for (const [task, modelConfig] of Object.entries(profile.roles)) {
  const card = { ...buildCard([], { taskId: task, today: new Date('2026-10-30') }),
    version: 1, policy_hash: hash(rolePolicy), profile_hash: hash(profile),
    selection_basis: 'approved_profile', modelConfig,
    why: 'Approved static role mapping; no controlled calibration runs',
    cost_usd: null, cost_source: 'unknown' };
  writeFileSync(new URL(`../policy/flora/cards/${task}.card.json`, import.meta.url), JSON.stringify(card, null, 2) + '\n');
}
console.log(JSON.stringify(validateFloraCards(), null, 2));
