# model-routing-cards

**Pick the right AI model for a job — and know when you can't.**

You have a few models to choose from. One is cheaper, one is stronger, one is
faster. For a job you run often, which should it be?

The usual answer is to try them both and pick the higher score. That works when
the difference is real. Often it isn't: models vary a lot between runs, and an
average hides that.

This runs the comparison properly and writes a small file — a **routing card** —
saying which model to use and how much to trust the answer.

## Try it

Thirty seconds, no signup, no key, nothing sent anywhere. The numbers are real
measurements, replayed from disk.

```sh
git clone https://github.com/srbryers/model-routing-cards
cd model-routing-cards
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

## Read that card

One model scored **49% higher on average**. The card still refused to pick it.

Look at the ranges. Gemini landed between 0.4042 and 0.4071 every time — almost
the same answer three times over. GPT-5.5 landed anywhere from 0.1771 to 0.459.
Its good runs and Gemini's good runs are in the same territory. The average was
hiding a model that changes its mind.

So the card says `NO_CLEAR_WINNER`, recommends the cheaper one, and tells you
why.

**That refusal is the whole idea.** A tool that always names a winner will
sometimes name one at random, and you will route real work on it for a month.

## What a card can say

| It says | It means |
|---|---|
| `CALIBRATED` | A real winner. Its worst run beat the other's best run. |
| `NO_CLEAR_WINNER` | They overlap. Here's the cheaper one, and why. |
| `SINGLE_CANDIDATE` | Only one model finished. Not a comparison. |
| `UNCALIBRATED` | Not enough runs yet. No recommendation at all. |

Cards carry a date and expire after **30 days**, because model line-ups change
and a stale card keeps recommending something that was retired.

## Set it up on your own work

The only hard part is writing the task file, and an agent sitting in your repo
can already see the prompt you actually send. Hand it this:

> Set up model-routing-cards in this repo.
>
> Clone https://github.com/srbryers/model-routing-cards and read
> `references/task-interface.md`.
>
> Find a job here where we call a language model more than once — a classifier,
> a summariser, a generator — and write a task file for it. Use the real prompt:
> import the function that builds it rather than retyping an approximation.
>
> Put facts in `gates` (did it parse, is it empty) and judgements in `metrics`.
>
> Then dry-run it, tell me what it would cost, and stop. Do not pass `--execute`
> until I say so.

It writes the file, you approve the spend, you get a card.

Using the real prompt is the part worth insisting on. An approximation measures
a copy of your pipeline, and the two differ exactly when it matters — in one
project, importing the real prompt builder is how a whole sprint's worth of
instructions was found to be missing from what the model actually received.

## Or write the task file yourself

One file. It says what the job is, and what a good answer looks like.

```js
export const task = {
  id: 'summarise',
  models: ['google/gemini-3.8-flash', 'openai/gpt-5.5'],
  runs: 3,

  input: { article: '…' },
  prompt: (input) => `Summarise this in two sentences:\n\n${input.article}`,

  score: (output) => ({
    gates:   { not_empty: output.trim().length > 0 },
    metrics: { brevity: output.length < 300 ? 1 : 0 },
  }),
  weights: { brevity: 1 },
};
```

`gates` are pass or fail — a run that fails one is thrown away, not scored low.
`metrics` are 0 to 1. Then:

```sh
node scripts/route.mjs run  my-task.mjs            # dry run — costs nothing
node scripts/route.mjs run  my-task.mjs --execute  # actually calls the models
node scripts/route.mjs card my-task.mjs            # write the card
```

Nothing is sent and no key is read without `--execute`.

## Two things it counts differently

**Cost per accepted result, not per call.** A model that is cheap and fails half
its runs is not cheap. You paid for the failures too.

**A subscription model is unmeasured, not free.** It is never tie-broken on
price against a metered one.

## Scoring things you can't count

Counting is the easy half. A model asked to lay out a page once returned eight
grids and sixteen columns with no words inside any of them — which a
count-the-elements score read as a success.

If your `score` needs to judge rather than count, it can ask a model:
[scoring by judgement](references/task-interface.md#scoring-by-judgement).

## More

- [Writing a task file](references/task-interface.md)
- [Using it from Claude Code](SKILL.md) — it works as a skill; that's optional
- Not a replacement for Braintrust, Promptfoo or an LLM gateway. Those route
  live production traffic. This answers a smaller question, on your machine,
  about one job.

MIT.
