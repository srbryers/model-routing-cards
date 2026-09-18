/**
 * The trust gate's tests. `node --test scripts/`
 *
 * ⚠⚠ EVERY CASE HERE IS A WAY THE TOOL COULD NAME A WINNER IT HAS NOT EARNED.
 * That is the only failure mode that matters: a routing card nobody checks, sat
 * in a repo, quietly sending every task to the wrong model because three runs
 * of noise once favoured it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCard, summarise, weigh, isStale, TRUST } from './card.mjs';

const run = (
  model,
  score,
  { gates = true, cost = 0.01, state = 'completed', cost_source = 'reported' } = {},
) => ({
  model,
  state,
  gates_passed: gates,
  cost_usd: cost,
  cost_source,
  metrics: { only: score },
});

test('weigh: no weights is the plain mean of metrics', () => {
  assert.equal(weigh({ a: 0.2, b: 0.4 }, {}), 0.30000000000000004);
  assert.equal(weigh({ a: 1, b: 0 }, { a: 1, b: 0 }), 1);
});

test('weigh: a metric the weights do not mention contributes nothing', () => {
  assert.equal(weigh({ a: 1, surprise: 1 }, { a: 0.5 }), 0.5);
});

test('UNCALIBRATED below the run floor, and it recommends NOTHING', () => {
  const card = buildCard([run('a', 0.9), run('a', 0.9)], { taskId: 't' });
  assert.equal(card.trust, 'UNCALIBRATED');
  assert.equal(card.recommend, null, 'a thin card must not name a model');
  assert.match(card.notes[0], /only 2 completed runs/);
});

test('a model that fails gates too often is disqualified whatever it scores', () => {
  /* ⚠ 0.99 on the two runs it completed, and out anyway — a gate failure is not
     a low score, it is a result that cannot be used. */
  const receipts = [
    run('loser', 0.99),
    run('loser', 0.99, { gates: false }),
    run('loser', 0.99, { gates: false }),
    run('winner', 0.2),
    run('winner', 0.2),
    run('winner', 0.2),
  ];
  const card = buildCard(receipts, { taskId: 't' });
  assert.equal(card.recommend, 'winner');
  assert.equal(card.trust, 'SINGLE_CANDIDATE');
  assert.ok(card.notes.some((n) => /loser.*disqualified/.test(n)));
});

test('SINGLE_CANDIDATE says plainly that it was not a comparison', () => {
  const card = buildCard([run('a', 0.5), run('a', 0.5), run('a', 0.5)], { taskId: 't' });
  assert.equal(card.trust, 'SINGLE_CANDIDATE');
  assert.match(card.why, /not a comparison/);
});

test('⚠⚠ overlapping ranges are NO_CLEAR_WINNER even when the means differ a lot', () => {
  /* The real case this was built from: means 0.41 vs 0.27, a 49% gap — and one
     of the loser's runs beat every run of the winner. A mean would have called
     it; the range must not. */
  const receipts = [
    run('steady', 0.40, { cost: 0.02 }),
    run('steady', 0.41, { cost: 0.02 }),
    run('steady', 0.41, { cost: 0.02 }),
    run('swingy', 0.18, { cost: 0.15 }),
    run('swingy', 0.46, { cost: 0.15 }),
    run('swingy', 0.18, { cost: 0.15 }),
  ];
  const card = buildCard(receipts, { taskId: 't' });
  assert.equal(card.trust, 'NO_CLEAR_WINNER');
  assert.equal(card.recommend, 'steady', 'the tie-break is cost per accepted result');
  assert.match(card.why, /ranges overlap/);
});

test('CALIBRATED only when the winner’s WORST run beats the runner-up’s BEST', () => {
  const receipts = [
    run('clear', 0.80),
    run('clear', 0.82),
    run('clear', 0.81),
    run('other', 0.20),
    run('other', 0.25),
    run('other', 0.22),
  ];
  const card = buildCard(receipts, { taskId: 't' });
  assert.equal(card.trust, 'CALIBRATED');
  assert.equal(card.recommend, 'clear');
  assert.match(card.why, /no overlap/);
});

test('a single point of overlap is still overlap', () => {
  /* ⚠ `>` not `>=`. Touching ranges are indistinguishable, and rounding a tie
     into a decision is the exact thing this gate exists to stop. */
  const receipts = [
    run('a', 0.5),
    run('a', 0.6),
    run('a', 0.5),
    run('b', 0.3),
    run('b', 0.5),
    run('b', 0.3),
  ];
  assert.equal(buildCard(receipts, { taskId: 't' }).trust, 'NO_CLEAR_WINNER');
});

test('⚠ cost per accepted result charges the rejects to the accepted runs', () => {
  /* Four calls at $0.10 = $0.40 spent; two usable. $0.20 each, not $0.10. */
  const receipts = [
    run('m', 0.5, { cost: 0.1 }),
    run('m', 0.5, { cost: 0.1 }),
    run('m', 0.5, { cost: 0.1, gates: false }),
    run('m', 0.5, { cost: 0.1, gates: false }),
  ];
  const [row] = summarise(receipts, {});
  assert.equal(row.cost_mean_usd, 0.1, 'mean per call is unchanged');
  assert.equal(row.cost_per_accepted_usd, 0.2, 'per ACCEPTED result is double');
});

test('runs that never completed are not scored, but are still counted as runs', () => {
  const receipts = [
    run('m', 0.9),
    run('m', 0.9),
    run('m', 0, { state: 'http_error' }),
  ];
  const [row] = summarise(receipts, {});
  assert.equal(row.runs, 3);
  assert.equal(row.completed, 2);
  assert.equal(row.score_mean, 0.9, 'a failed call must not drag the score toward zero');
});

test('a model with no completed runs at all reads as total gate failure', () => {
  const [row] = summarise([run('m', 0, { state: 'threw' })], {});
  assert.equal(row.completed, 0);
  assert.equal(row.gate_fail_rate, 1);
  assert.equal(row.cost_per_accepted_usd, null, 'no accepted runs means no per-accepted cost');
});

test('⚠⚠ a card goes stale, because the lineup it measured does not stand still', () => {
  const card = buildCard([run('a', 0.5), run('a', 0.5), run('a', 0.5)], {
    taskId: 't',
    today: new Date('2026-01-01'),
  });
  assert.equal(isStale(card, new Date('2026-01-20')), false);
  assert.equal(isStale(card, new Date('2026-03-01')), true, `${TRUST.STALE_DAYS} days`);
});

test('the card records the weights it was generated with', () => {
  const w = { only: 1 };
  const card = buildCard([run('a', 0.5), run('a', 0.5), run('a', 0.5)], { taskId: 't', weights: w });
  assert.deepEqual(card.weights, w, 'comparing cards across weight changes is meaningless');
});

test('⚠⚠ a subscription model is not cheap, it is unmeasured — no cost tie-break', () => {
  /* One model billed per token and one covered by a subscription are not
     cheaper and dearer than each other. With quality unable to separate them
     either, the honest card recommends NOTHING rather than picking the one
     whose cost column happens to be empty. */
  const receipts = [
    run('metered', 0.5, { cost: 0.02, cost_source: 'reported' }),
    run('metered', 0.6, { cost: 0.02, cost_source: 'reported' }),
    run('metered', 0.5, { cost: 0.02, cost_source: 'reported' }),
    run('subscription', 0.4, { cost: null, cost_source: 'subscription' }),
    run('subscription', 0.7, { cost: null, cost_source: 'subscription' }),
    run('subscription', 0.4, { cost: null, cost_source: 'subscription' }),
  ];
  const card = buildCard(receipts, { taskId: 't' });
  assert.equal(card.trust, 'NO_CLEAR_WINNER');
  assert.equal(card.recommend, null, 'no basis to choose must mean no choice');
  assert.match(card.why, /not comparable/);
  assert.match(card.why, /subscription/);
});

test('a subscription model still wins outright when quality separates it', () => {
  /* ⚠ The refusal above is about the TIE-BREAK, not about subscriptions. When
     one model's worst run beats the other's best, cost never enters it. */
  const receipts = [
    run('subscription', 0.9, { cost: null, cost_source: 'subscription' }),
    run('subscription', 0.92, { cost: null, cost_source: 'subscription' }),
    run('subscription', 0.91, { cost: null, cost_source: 'subscription' }),
    run('metered', 0.2, { cost: 0.01 }),
    run('metered', 0.25, { cost: 0.01 }),
    run('metered', 0.22, { cost: 0.01 }),
  ];
  const card = buildCard(receipts, { taskId: 't' });
  assert.equal(card.trust, 'CALIBRATED');
  assert.equal(card.recommend, 'subscription');
});

test('two subscription models CAN be compared — they are the same kind of cost', () => {
  const receipts = [
    run('a', 0.5, { cost: null, cost_source: 'subscription' }),
    run('a', 0.6, { cost: null, cost_source: 'subscription' }),
    run('a', 0.5, { cost: null, cost_source: 'subscription' }),
    run('b', 0.3, { cost: null, cost_source: 'subscription' }),
    run('b', 0.55, { cost: null, cost_source: 'subscription' }),
    run('b', 0.3, { cost: null, cost_source: 'subscription' }),
  ];
  const card = buildCard(receipts, { taskId: 't' });
  assert.equal(card.trust, 'NO_CLEAR_WINNER');
  /* ⚠ Same source, but neither has a per-accepted figure, so there is still
     nothing to break the tie with. Honest answer is still none. */
  assert.equal(card.recommend, null);
});
