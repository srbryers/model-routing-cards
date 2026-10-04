import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Search user-owned card locations; installed package files are never a card store. */
export function findCard(file, { cardsDir, repoDir, env = process.env, readFile = readFileSync }) {
  const directories = [cardsDir, env.MODEL_ROUTING_CARDS_DIR, join(repoDir, 'tasks', 'runs'),
    join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'model-routing', 'cards')];
  const why = [];
  for (const dir of [...new Set(directories.filter(Boolean).map(dir => resolve(dir)))]) {
    let text;
    try { text = readFile(join(dir, file), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      why.push(`card ${file} unreadable, ignored`);
      return { why };
    }
    let card;
    try { card = JSON.parse(text); }
    catch { return { why: [...why, `card ${file} malformed, ignored`] }; }
    const expected = file.slice(0, -'.card.json'.length);
    if (card?.task !== expected) return { why: [...why, `card task mismatch: expected ${expected}, ignored`] };
    return { card, why };
  }
  return { why };
}
