# The task interface

One file, one export. The project owns the two things only it can answer.

```js
export const task = {
  id: 'block-composition',          // names the receipts dir and the card
  models: ['a/model', 'b/model'],   // OpenRouter slugs, checked against the live catalog
  runs: 3,                          // per model; below 3 the card will not prefer one
  input: { /* anything your prompt and score need */ },
  schema: null,                     // optional json_schema, wrapped as {name, schema}

  prompt: (input) => '…',           // the REAL prompt, not an approximation
  score: (output, input) => ({      // may be async — see "Scoring by judgement"
    gates:   { parses: true, has_content: true },   // booleans; any false = unusable
    metrics: { accuracy: 0.8, structure: 0.4 },     // 0..1
  }),

  weights: { accuracy: 0.6, structure: 0.4 },       // locked; changing them re-dates the card
};
```

## ⚠⚠ Build the real prompt

`prompt` must produce what the system actually sends. An approximation measures a
copy of your pipeline rather than your pipeline — and the two diverge exactly
when it matters. In the wedding project this meant importing the real
`buildAgentPrompt`, which is also how a sprint's worth of targets was found to be
missing from the prompt entirely: the harness rendered what the model really got,
and the numbers were not in it.

## ⚠⚠ Gates before metrics, and a gate failure is not a low score

Fathoms' evaluator short-circuits to `0.0` on a failed hard gate rather than
averaging it away, because a mesh that will not import has no aesthetics worth
measuring. Model output is the same: a tree whose props do not survive the save
has not composed a page, however good it looks.

Gates are binary and cheap. Put the structural facts there — did it parse, is it
non-empty, did it keep the required shape — and leave `metrics` for degree.

## ⚠ Every structural measure needs a content measure beside it

Told to put half its sections side by side, a model returned eight grids,
sixteen columns, and not one heading, paragraph or image inside them. Measured as
`row + grid: 8` that reads as a success. It was an empty skeleton.

If a metric rewards structure, add one that requires substance, or the first
thing you optimise for is emptiness.

## ⚠ Score the thing you were promised, not the thing you can count

Prefer closeness to a stated target over a raw count. `photo_density` scores
distance from the design's own 35%, so both drought and flood lose points. A raw
count rewards whichever model produces most, which is rarely what was asked.

## Weights are locked

Changing weights changes what past receipts mean. The card records the weights it
was generated with; if you change them, regenerate rather than compare across.

## Scoring by judgement

`score` is awaited, so it may ask something. `scripts/jev.mjs` wraps a System One
model and returns the shape above directly: a Noul becomes a gate, a Score
becomes a metric normalised to 0..1.

```js
import { judge } from '../scripts/jev.mjs';

score: (output, input) => judge({
  state: { the_brief: input.brief, what_came_back: output },
  gates: { answers_the_brief: 'The page answers `the_brief`, not some other brief.' },
  metrics: {
    substance: {
      instructions: 'How much real content the page carries, against empty structure.',
      levels: [
        'Containers with almost no words inside them',
        'Some sections carry content, others are empty shells',
        'Every section carries real headings and paragraphs',
      ],
    },
  },
}),
```

⚠⚠ **MIX IT WITH CODE; DO NOT REPLACE CODE WITH IT.** Every question adds the
judge's own variance to a measurement whose point is variance. The structural
facts — did it parse, is it non-empty, did it keep the shape — belong in plain
JS, where they are free and exact. Spend questions on what has to be read.

```js
score: async (output, input) => {
  let tree;
  try { tree = JSON.parse(output); } catch { return { gates: { parses: false }, metrics: {} }; }
  const judged = await judge({ /* … the semantic half … */ });
  return { ...judged, gates: { parses: true, ...judged.gates } };
},
```

⚠ **LEVELS MUST DESCRIBE SITUATIONS, NOT DEGREES.** "Medium" is not a level; "some
sections carry content, others are empty shells" is. A ladder of adverbs gives
the judge nothing to recognise and produces a number that moves with the wind.

⚠ **CALIBRATE THE JUDGE BEFORE TRUSTING A CARD BUILT ON IT.**
`node scripts/jev.check.mjs` scores output already known to be good and bad, and
fails unless every good beats every bad. A judge that rates everything 0.7 makes
every card `NO_CLEAR_WINNER` — and the trust gate will faithfully report the
judge's indifference as if it were the models being indistinguishable.
