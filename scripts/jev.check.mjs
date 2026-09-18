#!/usr/bin/env node
/**
 * Does the Jev judge separate output we already know is good from output we
 * already know is bad?
 *
 * ⚠⚠ A SCORER NOBODY HAS CHECKED IS A NUMBER GENERATOR. A judge that rates
 * everything 0.7 produces a card whose ranges overlap for a reason that has
 * nothing to do with the models being compared, and the trust gate will
 * faithfully report NO_CLEAR_WINNER about the judge's indifference.
 *
 * The examples are real and the labels are not opinions. On 2026-09-18 a page
 * of 44 blocks was handed to a model with the instruction "make the first
 * heading slightly larger". Six runs under the whole-tree contract removed 32,
 * 10, 32, 38, 32 and 32 blocks. Under an edits contract, the same six kept all
 * 44. So "kept the page" and "deleted three quarters of it" are facts here,
 * not judgements — which is exactly what a judge should be tested against.
 *
 *   TYPESAFE_API_KEY=... node scripts/jev.check.mjs
 */
import { checkJudge } from './jev.mjs';

/** A small page, and what the instruction was. */
const BRIEF = 'Make the first heading slightly larger. Change nothing else.';

const WHOLE = {
  version: 1,
  root: [
    { id: 'title', type: 'heading', props: { text: 'Getting there' } },
    { id: 'intro', type: 'richText', props: { html: '<p>Fly to Madrid, then take the train.</p>' } },
    { id: 'trains', type: 'heading', props: { text: 'Trains' } },
    { id: 'trainsBody', type: 'richText', props: { html: '<p>Every half hour from Atocha.</p>' } },
    { id: 'cars', type: 'heading', props: { text: 'Driving' } },
    { id: 'carsBody', type: 'richText', props: { html: '<p>About 75 minutes on the A-42.</p>' } },
  ],
};

const bigger = (tree) => ({
  ...tree,
  root: tree.root.map((b) =>
    b.id === 'title' ? { ...b, props: { ...b.props, _layout: { textSize: { base: 'hero' } } } } : b,
  ),
});

/* ⚠ THE LABELS ARE STRUCTURAL FACTS, not my taste. Good = the heading grew and
   every other block survived. Bad = blocks the instruction never mentioned are
   gone, which is the failure that actually happened six times in a row. */
const good = [
  bigger(WHOLE),
  /* Also good: a different but legitimate way to say "larger". */
  {
    ...WHOLE,
    root: WHOLE.root.map((b) =>
      b.id === 'title' ? { ...b, props: { ...b.props, _layout: { textSize: { base: 'display' } } } } : b,
    ),
  },
];

const bad = [
  /* The real failure: heading grew, two thirds of the page vanished. */
  { version: 1, root: bigger(WHOLE).root.slice(0, 2) },
  /* The other real failure: everything kept, nothing actually changed. */
  WHOLE,
];

const result = await checkJudge({
  good,
  bad,
  stateFor: (output) =>
    JSON.stringify({
      the_instruction: BRIEF,
      the_page_before: WHOLE,
      the_page_after: output,
    }),
  gates: {
    kept_the_page:
      'Every block present in `the_page_before` is still present in `the_page_after`. ' +
      'Answer no if any block has disappeared, however good the rest of the change is.',
  },
  metrics: {
    did_the_job: {
      instructions:
        'How well `the_page_after` carries out `the_instruction`, judged only on ' +
        'whether the first heading is now visibly larger than it was.',
      levels: [
        'The first heading is unchanged — nothing was done',
        'Something changed, but not the first heading’s size',
        'The first heading is now larger and nothing else about it moved',
      ],
    },
    left_the_rest_alone: {
      instructions:
        'How much of `the_page_before` survived untouched into `the_page_after`, ' +
        'for an instruction that asked for one heading to change.',
      levels: [
        'Most of the page is gone or rewritten',
        'Some blocks were changed or removed that the instruction never mentioned',
        'Every other block is present and identical',
      ],
    },
  },
});

console.log(`\n  worst known-good : ${result.worstGood}`);
console.log(`  best known-bad   : ${result.bestBad}`);
console.log(`  margin           : ${result.margin}`);
console.log(`  bad runs the gate rejected: ${result.gatesRejectedBad}/${result.bads.length}`);
console.log(
  `\n  ${result.separates ? '✓ the judge separates them' : '✗ THE JUDGE DOES NOT SEPARATE THEM — do not build a card on it'}\n`,
);

for (const [label, rows] of [
  ['good', result.goods],
  ['bad', result.bads],
]) {
  for (const r of rows) {
    const m = Object.entries(r.detail.metrics)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ');
    console.log(`  ${label.padEnd(5)} mean ${r.mean.toFixed(3)}  gates ${r.gatesPassed ? 'pass' : 'FAIL'}  ${m}`);
  }
}

process.exit(result.separates ? 0 : 1);
