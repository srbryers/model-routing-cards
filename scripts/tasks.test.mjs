/**
 * The code half of every coding task, checked offline against known outputs.
 *
 * ⚠ THIS TESTS THE GATES, NOT THE JUDGE. Jev's half needs a key and its own
 * calibration (scripts/jev.check.mjs pattern). What is checked here is free and
 * exact: a known-good answer clears every code gate, and a known-bad one either
 * fails a gate or scores below the good one on the code metrics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TASKS = ['implementation', 'bug-fix', 'review', 'quick-edit'];

const passes = (r) => Object.values(r.gates).every(Boolean);
const mean = (m) => {
  const v = Object.values(m);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
};

for (const name of TASKS) {
  const mod = await import(`../tasks/${name}.mjs`);

  test(`${name}: follows the task interface and starts UNCALIBRATED`, () => {
    const { task } = mod;
    assert.equal(task.id, name);
    assert.ok(task.models.length >= 2, 'a card needs at least two candidates to compare');
    assert.ok(task.runs >= 3, 'below 3 runs the card will not prefer a model');
    assert.equal(typeof task.score, 'function');
    assert.equal(task.calibration.status, 'UNCALIBRATED');
    const sum = Object.values(task.weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
    const p = task.prompt(task.input);
    assert.ok(p.includes('## Goal') && p.includes('## Files') && p.includes('## What to return'));
  });

  test(`${name}: known-good output clears every code gate`, () => {
    for (const out of mod.examples.good) {
      const r = mod.check(out, mod.task.input);
      assert.ok(passes(r), `gates: ${JSON.stringify(r.gates)} ${JSON.stringify(r.raw)}`);
    }
  });

  test(`${name}: known-bad output fails a gate or scores lower`, () => {
    const best = Math.min(...mod.examples.good.map((o) => mean(mod.check(o, mod.task.input).metrics)));
    for (const out of mod.examples.bad) {
      const r = mod.check(out, mod.task.input);
      assert.ok(
        !passes(r) || mean(r.metrics) < best,
        `bad output passed with ${JSON.stringify(r.metrics)} vs good ${best}`,
      );
    }
  });
}
