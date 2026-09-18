---
name: model-routing
description: Decide which model should do a specific task, from measurement rather than habit, and record the decision as a routing card with a trust status. Use when picking a worker model for a recurring sub-task, when a model choice is being made on vibes, or when an existing card has expired. Not for production traffic routing.
---

# Model routing

**A routing card says which model to use for one task, and whether to believe it.**

⚠⚠ **This is not an eval platform and must not grow into one.** Braintrust,
Promptfoo, DeepEval and TrueFoundry already do production evaluation, tracing,
online scoring and gateway routing, and they do it better than a local script
will. They route **live traffic**. This answers a different question: an agent
working in a repo needs to hand a sub-task to a worker model, on this machine,
now — and needs to know whether that choice rests on anything.

## The split that makes it portable

A benchmark is not portable; the discipline around one is.

| Owner | Supplies |
|---|---|
| **The project** | what the task is (`prompt`), and what counts as good (`score`) |
| **This tool** | running, catalog price checks, receipts, aggregation, variance, cost per accepted result, the trust gate, the card |

A task is one file exporting `{ id, models, prompt, score, weights }`. See
[the task interface](references/task-interface.md).

## Use it

```sh
node scripts/route.mjs run  path/to/task.mjs              # dry — nothing sent
node scripts/route.mjs run  path/to/task.mjs --execute    # spends
node scripts/route.mjs card path/to/task.mjs              # emit the card
```

Dry by default: without `--execute` no credential is read and no request is
made. Receipts are keyed by model per run. A second `run` skips recorded work
unless `--force`.

## ⚠⚠ The trust gate is the point

A tool that always names a winner will name one from noise. This one refuses:

| Status | When | Card says |
|---|---|---|
| `UNCALIBRATED` | fewer than 3 completed runs for every model | no recommendation at all |
| `SINGLE_CANDIDATE` | only one model cleared the gates | names it, and says this was not a comparison |
| `NO_CLEAR_WINNER` | the top two models' **run ranges overlap** | recommends the cheaper per accepted result, and says why |
| `CALIBRATED` | top model's worst run beats the runner-up's best | names it |

A model failing its gates more than a third of the time is **disqualified
whatever it scores** — a gate failure produces an unusable result, not a low
score.

⚠ **Report the range, not the mean.** The first real card compared two models
whose means differed by 49%; their ranges overlapped, because one was
near-deterministic and the other varied threefold run to run. A mean would have
declared a winner from variance.

## Scoring what a regex cannot settle

`score` may be async, so it can ask. `scripts/jev.mjs` wraps a System One model
and returns the interface's own shape: a Noul is a gate, a Score is a metric
normalised to 0..1. Every gate and metric for one output goes in one request.

```js
score: (output, input) => judge({
  state: { the_brief: input.brief, what_came_back: output },
  gates: { answers_the_brief: 'The page answers `the_brief`, not some other brief.' },
  metrics: { substance: { instructions: '…', levels: ['worst', 'middle', 'best'] } },
}),
```

⚠⚠ **Jev for judgement, code for facts.** Every question adds the judge's own
variance to a measurement whose point is variance. `parses`, `non_empty`, kept
the shape — plain JS, free and exact. Spend questions only on what has to be
read. Measured elsewhere: the same sweep five times found what it sought 3/3
every run and threw **0 to 2 false positives**; a substring check removed them.

⚠ **Calibrate the judge first** — `node scripts/jev.check.mjs`. A judge that
rates everything 0.7 makes every card `NO_CLEAR_WINNER` about its own
indifference, and the trust gate will report that as the models being
indistinguishable.

## ⚠ Cost per accepted result, not per call

A model that is cheap and fails half its gates is not cheap — you pay for the
rejects too. This is the number a router should optimise and the one every
price-per-million table hides.

## ⚠⚠ A card expires; a benchmark does not

Fathoms freezes its ten prompts on purpose: to compare pipeline versions, a
moving target is useless. Routing is the opposite question — model lineups
change monthly, so a card that cannot go stale will keep recommending a model
that was retired. **Same machinery, opposite lifetime.** Cards carry a
generation date and expire in 30 days. Do not reuse a routing card as a
regression benchmark, or freeze a benchmark and call it routing.

## What it does not do

- **No production traffic.** Use a gateway for that.
- **No scoring help.** The project writes `score`; the tool cannot know what
  good looks like for your task, and pretending otherwise is how a generic
  metric becomes a wrong decision.
- **Not billing authority.** It records reported costs. Other tools, other
  passes and account use spend outside it.
- **Not a licence to spend.** `--execute` is a deliberate act each time.
