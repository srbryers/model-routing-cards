# Routing Profile

**Sebastian's chosen routing policy. Draft for his review.**

This is policy: what we decided to do. The benchmark evidence that informed it
is kept separately in
[`references/best-models-per-work-type.md`](references/best-models-per-work-type.md)
and is not policy. Where the two disagree, this file wins until a routing card
says otherwise.

> ⚠⚠ **ONE INTERPRETATION NEEDS CONFIRMATION.** Sebastian said both "Opus 5.5
> on extra high for most tasks" and "Spark as the everyday builder". This file
> encodes: **Muse Spark by default; Opus 5.5 at extra-high effort for the
> demanding categories below.** If "most tasks" meant Opus should be the default,
> the Default column flips and Spark becomes the cheap option for small work.

> ⚠ **NOTHING HERE IS MEASURED YET.** Every card is `UNCALIBRATED`. The choices
> below are starting points that the cards exist to confirm or overturn.

## Who does what

| Work type | Default | Also measured | Card | Card status |
|---|---|---|---|---|
| Everyday building | **Muse Spark** | Opus 5.5 | `tasks/implementation.mjs` | `UNCALIBRATED` |
| Demanding work | **Opus 5.5, extra-high effort** | — | none yet | — |
| UI work | **Opus 5.5, extra-high effort** | — | none yet | — |
| iOS work | **Opus 5.5, extra-high effort** | — | none yet | — |
| Architectural decisions | **Opus 5.5, extra-high effort** | — | none yet | — |
| Recovery after repeated failures | **Opus 5.5, extra-high effort** | — | none yet | — |
| Bug fixes | candidates: **Sonnet 5.5, GPT-6 Luna** | — | `tasks/bug-fix.mjs` | `UNCALIBRATED` |
| Code review | rotate candidates (see below) | Opus 5.5, Sonnet 5.5, DeepSeek V4 Pro | `tasks/review.mjs` | `UNCALIBRATED` |
| Quick, well-scoped edits | **Muse Spark** (everyday builder) | GPT-6 Luna | `tasks/quick-edit.mjs` | `UNCALIBRATED` |
| Semantic judgement in scoring | **Jev** | — | `scripts/jev.check.mjs` | not run on these tasks |

Open choices in this table, not yet decided by Sebastian:

- **"Repeated failures" has no threshold.** Proposed: escalate to Opus after
  the default model fails the same task twice.
- **Bug fixes have two candidates and no default.** The card decides; until it
  has, either may be used.
- **The review candidates are a draft.** Opus and Sonnet come from this profile;
  DeepSeek V4 Pro was added because it had the best measured review recall.
- **Quick edits default to Spark** because the profile names it the everyday
  builder. The evidence favours Luna on cost; the card compares them.

## Rules

### Jev judges meaning; code owns facts

- **Jev is the semantic judge.** It answers what has to be read: did the
  diagnosis name the real cause, does the code fit the file's style, is a
  review finding real or noise.
- **Deterministic code owns every factual gate.** Did it parse, did the tests
  pass, is the quoted line in the diff, how many lines changed.
- **Jev never counts and never does arithmetic.** Recall, line counts, test pass
  rates and closeness to a target are computed in code. If a question can be
  settled by a regex or a test, it is not a Jev question.
- **Code gates run first.** If any fails, the run is discarded and Jev is not
  called.

### Selected models run as subagents with full context

A selected model is handed the whole job, never a bare prompt: its role, the
goal, the background, the files it touches, the constraints, and the exact
shape of the answer. `brief()` in `tasks/_harness.mjs` builds that briefing,
and every task here measures models on it.

### Review candidates rotate

For review tasks, the candidate may be swapped or chosen by coin flip, so the
system collects comparison evidence during normal work instead of only in
bake-offs. A review is never a merge gate on its own: no measured model finds
most human-flagged bugs (best recall 44.2%).

### Trust gate

A card's status decides how much its recommendation counts.

| Status | Meaning | What to do |
|---|---|---|
| `UNCALIBRATED` | Too few clean runs | Follow this profile; the card says nothing |
| `SINGLE_CANDIDATE` | Only one model cleared the gates | Use it, but it was not a comparison |
| `NO_CLEAR_WINNER` | Run ranges overlap | Use the cheaper per accepted result, if costs are comparable |
| `CALIBRATED` | Winner's worst run beat runner-up's best | Follow the card over this profile |

Cards expire after **30 days**.

### Report ranges, never just means

Every reported score carries its run range: `0.71 (0.64–0.78)`, not `0.71`. A
mean difference smaller than the spread is not a finding.

## Known gaps before the first real run

| Gap | Effect | Fix |
|---|---|---|
| Model slugs are unverified | A wrong slug fails at `--execute`, before any spend | Check against the OpenRouter catalog; fix in `tasks/_harness.mjs` |
| Muse Spark may not be on OpenRouter | Its runs cannot happen through the current providers | Add a Meta provider to `scripts/providers.mjs` |
| Effort is not sent | Opus runs at its provider default, not extra-high | Pass reasoning effort through `scripts/providers.mjs` |
| Runs are single-turn | Measures one-shot answers with full context, not an agent loop with tools | Accept for now, or add an agent provider |
| Jev questions are unchecked | A judge that rates everything alike makes every card `NO_CLEAR_WINNER` | Run each task's `examples` through `checkJudge` |
| Latency is not scored | Matters most for quick edits | Read `ms` from receipts |
| No cards for the Opus categories | UI, iOS, architecture and recovery rest on policy alone | Write tasks for them |
