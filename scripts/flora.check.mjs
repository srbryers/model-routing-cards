/** Offline prerequisite receipt. Accept a fixture card to test rejection. */
import { readFileSync } from 'node:fs';
import { validateFloraCards, loadFloraCards, validateRoutingDecision } from './flora.mjs';
try {
  const cards = loadFloraCards();
  if (process.argv[2] === '--decision') {
    validateRoutingDecision(JSON.parse(readFileSync(process.argv[3], 'utf8')));
  } else if (process.argv[2]) {
    const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const index = cards.findIndex(card => card.task === fixture.task);
    if (index < 0) throw new Error('Fixture task missing from live cards');
    cards[index] = fixture;
  }
  console.log(JSON.stringify({ ...validateFloraCards(cards), providerCalls: 0 }, null, 2));
} catch (error) {
  console.error(`FAIL: ${error.message}; providerCalls=0`);
  process.exitCode = 1;
}
