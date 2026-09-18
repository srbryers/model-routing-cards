# Model Routing Cards

**Pick the right AI model for a job, and know when you can't.**

You have a few models to choose from. One is cheaper, one is stronger, one is
faster. For a job you run often, which should it be?

The usual answer is to try them both and pick the higher score. That works when
the difference is real. Often it isn't: models vary a lot between runs, and an
average hides that.

This runs the comparison properly and writes a small file called a
**routing card**. It says which model to use, and how much to trust the
answer.

## Try It

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

## Read That Card

Gemini averaged **49% higher** than GPT-5.5. The card recommends Gemini, but not
for that reason.

Look at the ranges. Gemini scored 0.4042 to 0.4071 across three runs. GPT-5.5
scored 0.1771 to 0.459. Those overlap, so three runs do not establish that
either model is better. The averages differ. The evidence does not.

So the card reports `NO_CLEAR_WINNER` and falls back to cost: $0.0219 against
$0.1452 per accepted result.

The recommendation is the same either way. What you gain is knowing it rests on
price rather than quality, and that more runs could change it.

You can check every number above by running the two commands in the previous
section.

## What a Card Can Say

| It says | It means |
|---|---|
| `CALIBRATED` | A real winner. Its worst run beat the other's best run. |
| `NO_CLEAR_WINNER` | They overlap. Here's the cheaper one, and why. |
| `SINGLE_CANDIDATE` | Only one model finished. Not a comparison. |
| `UNCALIBRATED` | Not enough runs yet. No recommendation at all. |

Cards carry a date and expire after **30 days**, because model line-ups change
and a stale card keeps recommending something that was retired.

## Set It Up on Your Own Work

Writing the task file is the part that takes thought. An agent working in your
repo can read the prompt you actually send, which is the detail most worth
getting right. Hand it this:

> Set up model-routing-cards in this repo.
>
> Clone https://github.com/srbryers/model-routing-cards and read
> `references/task-interface.md`.
>
> Find a job here where we call a language model more than once: a classifier,
> a summariser, a generator. Write a task file for it, using the real prompt.
> Import the function that builds the prompt rather than retyping it.
>
> Put facts in `gates` (did it parse, is it empty) and judgements in `metrics`.
>
> Then dry-run it, tell me what it would cost, and stop. Do not pass `--execute`
> until I say so.

It writes the file, you approve the spend, you get a card.

Why the real prompt matters: an approximation measures a copy of your pipeline,
not your pipeline. In one project, importing the real prompt builder showed that
a set of instructions added a week earlier was not reaching the model at all.
Every test of those instructions had passed, because they tested the function
that produced them rather than the text that was sent.

## Or Write the Task File Yourself

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

`gates` are pass or fail. A run that fails one is thrown away rather than
scored low. `metrics` are 0 to 1. Then:

```sh
node scripts/route.mjs run  my-task.mjs            # dry run — costs nothing
node scripts/route.mjs run  my-task.mjs --execute  # actually calls the models
node scripts/route.mjs card my-task.mjs            # write the card
```

Nothing is sent and no key is read without `--execute`.

## How Cost Is Counted

**Per accepted result, not per call.** A model that is cheap and fails half its
runs costs twice its headline price, because you paid for the failed runs too.

**A subscription model is recorded as unmeasured, not free.** Cards never break
a tie on price when one model is metered and the other is not.

## Scoring What You Cannot Count

A `score` that counts elements can be satisfied by output that is empty. A model
asked to lay out a page once returned eight grids and sixteen columns with no
text inside any of them, and a count of layout elements read that as a success.

If your `score` needs to judge rather than count, it can ask a model:
[scoring by judgement](references/task-interface.md#scoring-by-judgement).

## More

- [Writing a task file](references/task-interface.md)
- [Using it from Claude Code](SKILL.md). Working as a skill is optional.
- Not a replacement for Braintrust, Promptfoo or an LLM gateway. Those route
  live production traffic. This answers a smaller question, on your machine,
  about one job.

MIT.
