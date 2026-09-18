# model-routing

**Which model for this task, and whether to believe it.**

Most bake-off scripts always name a winner. This one often refuses.

**A measurement that looks fine and is wrong is worse than no measurement**,
because you act on it. Two that happened here:

- The first real card compared two models whose mean scores differed by **49%**.
  It declined to prefer either, because their run *ranges overlapped* — one model
  was near-deterministic, the other varied threefold from run to run. A mean
  would have picked a winner from variance, and an agent would have routed real
  work on it for a month.
- A model told to put half its sections side by side returned eight grids,
  sixteen columns, and **not one heading, paragraph or image inside them**.
  Scored as `row + grid: 8`, that reads as a success. It was an empty skeleton,
  and the metric was cheering.

Hence a trust gate that can say *I don't know*, ranges instead of means, cost per
**accepted** result, and — for the second kind of failure — scoring that can
actually read the output.

A routing card is a small JSON artifact a skill or agent can read, naming the
model to use for one task — with a trust status attached. If the evidence is
thin the card says so and declines to prefer a model.

See it for yourself without spending anything, or holding a key — the receipts
are real measurements, replayed:

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

`SKILL.md` is what a [Claude Code](https://code.claude.com) agent loads when the
skill triggers: the operating rules, short enough to sit in a context window.
This README is for you. They overlap, and the duplication is deliberate — an
agent cannot cheaply follow a link mid-task.

Using it as a skill is optional. Everything here runs as plain Node.

## ⚠⚠ This is not an eval platform and must not become one

Braintrust, Promptfoo, DeepEval and TrueFoundry already do production
evaluation, tracing, online scoring and gateway routing, and they do it better
than a local script will. They all route **live traffic**.

This answers a different question: *an agent working in a repo needs to hand a
sub-task to a worker model, on this machine, now — and needs to know whether
that choice rests on anything.*

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

Dry by default: without `--execute` no credential is read and no request is made.

## Providers

| prefix | route | cost |
|---|---|---|
| *(none)* | OpenRouter | reported per call |
| `chatgpt:` | `chatgpt.com/backend-api/codex/responses` | **subscription** |
| `codex:` | shells out to the `codex` CLI | **subscription** |

⚠ The `chatgpt:` route is the one `pi-imagen` uses. It is **not** the documented
public API and may change without notice. `~/.codex/auth.json` is a password: it
is read, sent only to chatgpt.com, and never printed or written to a receipt.

⚠ `codex:` is an **agent**, not a completion. It is confined to an empty
directory with `--sandbox read-only`, because unconfined it goes exploring — one
call in another repo returned that repo's git state instead of an answer, at
roughly 24× a normal call's tokens. It also measured ~3× slower than `chatgpt:`.

## ⚠⚠ The trust gate is the point

A tool that always names a winner will name one from noise.

| Status | When | Card says |
|---|---|---|
| `UNCALIBRATED` | fewer than 3 completed runs | no recommendation at all |
| `SINGLE_CANDIDATE` | one model cleared the gates | names it, says it was not a comparison |
| `NO_CLEAR_WINNER` | the top two **run ranges overlap** | the cheaper per accepted result — or nothing, if costs are not comparable |
| `CALIBRATED` | the winner's worst run beats the runner-up's best | names it |

A model failing gates more than a third of the time is **disqualified whatever
it scores** — a gate failure is not a low score, it is a result that cannot be
used.

**Report the range, not the mean.** The first real card compared two models whose
means differed by 49%; their ranges overlapped, because one was
near-deterministic and the other varied threefold run to run.

**Cost per accepted result, not per call.** A model that is cheap and fails half
its gates is not cheap — you pay for the rejects too.

**A subscription model is not cheap, it is unmeasured.** Mixed cost sources are
never tie-broken on price.

## ⚠⚠ A card expires; a benchmark does not

Freezing a benchmark is right for comparing pipeline versions — a moving target
is useless there. Routing is the opposite question: model lineups change monthly,
so a card that cannot go stale keeps recommending a model that was retired.
**Same machinery, opposite lifetime.** Cards carry a generation date and expire
in 30 days.

## Task interface

One file, one export. See [references/task-interface.md](references/task-interface.md).

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

`score` is the project's job, and counting is the easy half. The hard half is in
[the task interface](references/task-interface.md) as a scar:

> Told to put half its sections side by side, a model returned eight grids,
> sixteen columns, and not one heading, paragraph or image inside them. Measured
> as `row + grid: 8` that reads as a success. It was an empty skeleton.

A regex cannot tell you whether copy is any good. `scripts/jev.mjs` asks a
[System One model](https://docs.typesafe.ai) instead, and its primitives land
exactly on the two fields the interface already has — a Noul is a gate, a Score
is a metric:

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

Every gate and metric for one output goes in **one request** — independent
questions run in parallel — so a full scoring costs about 400ms and a fraction
of a cent. That matters more than it sounds: the trust gate is starved of runs,
and cheap scoring is what buys the extra runs that narrow a range.

⚠⚠ **Jev for judgement, code for facts.** Every question asked adds the judge's
own variance to a measurement whose entire point is variance. Put `parses`,
`non_empty` and anything a regex settles in plain JS; spend questions only on
what needs reading. On a neighbouring task the same sweep run five times found
what it was looking for 3/3 every time and threw **0 to 2 false positives
depending on the run** — a substring check in code removed them completely.

⚠ **A judge needs its own calibration.** `node scripts/jev.check.mjs` scores
output already known to be good and bad and refuses to pass unless every good
beats every bad. Measured across four runs: margin **0.42–0.45**, and the gate
correctly rejected the run that deleted blocks while letting through the run
that changed nothing — a low score, not an unusable result.

## What it does not do

- **No production traffic.** Use a gateway for that.
- **No opinion about what good means.** The tool now supplies a *mechanism* for
  judging (above), but the project still writes every gate and every level. A
  generic metric is a wrong decision waiting to happen, and naming the levels is
  where the thinking lives.
- **Not billing authority.** It records reported costs. Other tools, other passes
  and account use spend outside it.
- **Not a licence to spend.** `--execute` is a deliberate act each time.
