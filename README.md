# model-routing

**Which model for this task, and whether to believe it.**

Most bake-off scripts always name a winner. This one often refuses.

A measurement that looks fine and is wrong is worse than no measurement. Two
examples:

- Two models had mean scores differing by **49%**. The tool declined to prefer
  either because their run ranges overlapped; one model was near-deterministic,
  while the other varied threefold from run to run. A mean would have picked a
  winner from variance, routing real work to it for a month.
- A model told to put half its sections side by side returned eight grids,
  sixteen columns, and **not one heading, paragraph or image inside them**.
  Scored as `row + grid: 8`, it read as a success despite being an empty
  skeleton.

This tool uses a trust gate that can say *I don't know*, ranges instead of
means, cost per **accepted** result, and scoring that reads output.

A routing card is a JSON artifact naming the model for a task with a trust
status. If evidence is thin, it declines to prefer a model.

Replay real measurements without keys or spend:

```sh
node seed-from-today.mjs
node scripts/route.mjs card example-task.mjs
```

```
=== routing card — block-composition ===
trust      NO_CLEAR_WINNER
recommend  google/gemini-3.8-flash
why        run ranges overlap (google/gemini-3.8-flash 0.4042-0.4071 vs
           openai/gpt-5.5 0.1771-0.459); recommending the cheaper per accepted result

model                            ok/run  gatefail  score (min–max)         $/accepted
──────────────────────────────────────────────────────────────────────────────────────
google/gemini-3.8-flash            3/3        0%  0.4053 (0.4042–0.4071)    $0.0219
openai/gpt-5.5                     3/3        0%  0.2716 (0.1771–0.459)     $0.1452
```

## Two files, on purpose

`SKILL.md` contains operating rules for a [Claude Code](https://code.claude.com)
agent context window. This README is for humans. The duplication is deliberate;
an agent cannot cheaply follow links mid-task. Skill use is optional; everything
runs as plain Node.

## ⚠⚠ This is not an eval platform and must not become one

Braintrust, Promptfoo, DeepEval, and TrueFoundry handle production evaluation,
tracing, online scoring, and gateway routing for **live traffic**.

This tool answers a local question: an agent working in a repo needs to hand a
sub-task to a worker model on this machine now, and needs to verify that choice
rests on evidence.

## The split that makes it portable

A benchmark is never portable. The discipline around one is.

| Owner | Supplies |
|---|---|
| **The project** | what the task is (`prompt`), what counts as good (`score`) |
| **This tool** | running, providers, catalog price checks, receipts, variance, cost per accepted result, the trust gate, the card |

## Use

```sh
node scripts/route.mjs run  path/to/task.mjs            # dry — nothing sent
node scripts/route.mjs run  path/to/task.mjs --execute  # spends
node scripts/route.mjs card path/to/task.mjs            # emit the card
npm test                                                # the trust gate's tests
```

Without `--execute`, no credential is read and no request is made.

## Providers

| prefix | route | cost |
|---|---|---|
| *(none)* | OpenRouter | reported per call |
| `chatgpt:` | `chatgpt.com/backend-api/codex/responses` | **subscription** |
| `codex:` | shells out to the `codex` CLI | **subscription** |

⚠ The `chatgpt:` route is what `pi-imagen` uses. It is **not** a documented
public API and may change without notice. `~/.codex/auth.json` is sent only to
chatgpt.com; it is never printed or written to a receipt.

⚠ `codex:` is an **agent**, not a completion. It is confined to an empty
directory with `--sandbox read-only`. Unconfined, one call in another repo
returned that repo's git state instead of an answer at roughly 24× a normal
call's tokens. It measured ~3× slower than `chatgpt:`.

## ⚠⚠ The trust gate is the point

| Status | When | Card says |
|---|---|---|
| `UNCALIBRATED` | fewer than 3 completed runs | no recommendation at all |
| `SINGLE_CANDIDATE` | one model cleared the gates | names it, says it was not a comparison |
| `NO_CLEAR_WINNER` | the top two **run ranges overlap** | the cheaper per accepted result — or nothing, if costs are not comparable |
| `CALIBRATED` | the winner's worst run beats the runner-up's best | names it |

A model failing gates more than a third of the time is **disqualified whatever
it scores**; a gate failure cannot be used.

**Report the range, not the mean.** Two models whose means differed by 49% had
overlapping ranges because one was near-deterministic and the other varied
threefold run to run.

**Cost per accepted result, not per call.** You pay for rejected runs too.

**A subscription model is unmeasured, not cheap.** Mixed cost sources are never
tie-broken on price.

## ⚠⚠ A card expires; a benchmark does not

Freezing a benchmark is right for comparing pipeline versions — a moving target
is useless there. Routing is the opposite question: model lineups change monthly,
so a card that cannot go stale keeps recommending a model that was retired.
**Same machinery, opposite lifetime.** Cards carry a generation date and expire
in 30 days.

## Task interface

One file, one export. See
[references/task-interface.md](references/task-interface.md).

```js
export const task = {
  id: 'block-composition',
  models: ['google/gemini-3.8-flash', 'chatgpt:gpt-5.5'],
  runs: 3,
  input: { brief: '…' },
  prompt: (input) => '…',          // the REAL prompt, not an approximation
  score: (output, input) => ({
    gates:   { parses: true, has_content: true },
    metrics: { accuracy: 0.8 },
  }),
  weights: { accuracy: 1 },        // locked
};
```

## Scoring what cannot be counted

The empty skeleton at the top of this page is the problem: a regex can count
eight grids, and cannot tell you the page is empty. `scripts/jev.mjs` calls a
[System One model](https://docs.typesafe.ai) instead, where a Noul is a gate and
a Score is a metric:

```js
import { judge } from '../scripts/jev.mjs';

score: (output, input) => judge({
  state: { the_brief: input.brief, what_came_back: output },
  gates: {
    answers_the_brief:
      'The page is an answer to `the_brief`, not a page about something else.',
  },
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

Gates and metrics for one output run in **one request** in parallel, costing
about 400ms and a fraction of a cent. Cheap scoring buys the extra runs needed
to narrow a range.

⚠⚠ **Jev for judgement, code for facts.** Every prompt adds judge variance. Put
`parses`, `non_empty`, and regex checks in plain JS. Across five runs on a
neighboring task, a prompt found targets 3/3 times but threw **0 to 2 false
positives depending on the run**; a substring check in code eliminated them.

⚠ **A judge needs its own calibration.** `node scripts/jev.check.mjs` scores
known good and bad outputs, requiring every good output to beat every bad
output. Measured across four runs: margin **0.42–0.45**. The gate rejected a run
that deleted blocks while passing a run that changed nothing.

## What it does not do

- **No production traffic.** Use a gateway.
- **No opinion about what good means.** The project specifies every gate and
  level.
- **Not billing authority.** Records reported costs only.
- **Not a licence to spend.** `--execute` is required each time.
