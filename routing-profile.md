# Routing Profile

**Sebastian's chosen routing policy. Draft for his review.**

This is policy: what we decided to do. The benchmark evidence that informed it
is kept separately in
[`references/best-models-per-work-type.md`](references/best-models-per-work-type.md)
and is not policy. Where the two disagree, this file wins until a routing card
says otherwise.

> ⚠⚠ **ONE INTERPRETATION NEEDS CONFIRMATION.** Sebastian said both "Opus 5.5
> on extra high for most tasks" and "Spark as the everyday builder". This file
> encodes: **Muse Spark by default; `opus` at extra-high effort for the
> demanding categories below.** If "most tasks" meant Opus should be the default,
> the Default column flips and Spark becomes the cheap option for small work.

> ⚠ **NOTHING HERE IS MEASURED YET.** Every card is `UNCALIBRATED`. The choices
> below are starting points that the cards exist to confirm or overturn.

## Latest Model Aliases

Default standing model picks to the latest alias accepted by their provider path. On Claude Code, the latest aliases are the bare names `opus` and `sonnet`. On 2026-10-31, the coordinator's subscription probes resolved them to `claude-opus-5-5` and `claude-sonnet-5-5`, respectively. The API returned 404 for both `opus@latest` and `sonnet@latest`. See [the run record](RESULT-LATEST.md) for the probe results.

| Route | Exception Reason |
|---|---|
| `terra`, `sol`, `astra` | Policy records latest family intent. The router resolves it from the Codex catalogue at pick time, with the standing ID as fallback. |
| `gpt-5.5` | No family suffix; absent from the Codex cache. A family cannot be resolved without inventing an ID. |
| `luna` | Keep `gpt-5.6-luna` and `openai/gpt-5.6-luna` for the exact-identity mismatch tests and stale-identity guard. |
| `muse` | The installed Muse profile resolves `muse-spark-1.3`; no latest alias is documented on the ACP path. No latest form was established. |
| `pi-local` | The model comes from local configuration; there is no shared model pin to convert. |
| `fw-kimi-k3`, `fw-glm-5p3`, `fw-deepseek-v4p1-flash`, `fw-minimax-m3`, `fw-qwen3p8-max`, `fw-gpt-oss-120b` | Spend-gated measurement candidates with exact Fireworks identities; no latest form was established on Pi. |
| `gemini-pro`, `gemini-flash`, `gemini-flash-lite` | Spend-gated ACP/Vertex candidates; no latest form was established on that path. |
| `or-gemini-flash`, `or-gemini-pro` | Spend-gated Pi/OpenRouter candidates, disabled for credit exhaustion; no latest form was established. |
| `gemini-copy`, `openai-image` | Spend-gated external instructions; neither supplies standing worker spawn arguments. |
| Flora `muse-wonder` | The Muse platform orchestrator has a strict identity pin in `scripts/flora.mjs`; it is separate from generic Muse Spark. |
| Flora `jev` | Already `jev-latest`; retain the alias and semantic identity hold. |

`cardModels`, Flora `cardIdentity`, and task measurement candidates keep their exact model identities. They match recorded card rows, not CLI selection tags. A latest tag does not relabel past measurements or establish current calibration. Flora retains `flora-pilot` scope and its role, fallback, and authority limits.

## Codex Latest Resolution

Regular picks for Terra, Sol, and Astra read latest intent from policy. The CLI
loads `~/.codex/models_cache.json`. The pure resolver selects the highest numeric
version ending in the family suffix. Equal versions retain the standing ID when
present; otherwise catalogue order decides. Unparseable slugs are ignored.

The policy model remains the standing fallback. A missing, unreadable, malformed,
or family-empty catalogue returns that ID with `source: "fallback"` and
`fallback: true`. Luna is explicitly excluded.

A decision's `model` is the resolved spawn ID. Its `modelResolution` records the
family, latest intent, standing ID, resolved ID, source, and fallback flag.
A changed ID also appears in `why`. Outcomes copy the model and resolution so
recorded results identify the model that ran.

Flora picks retain their separate profile validation and selection path. This
pass does not resolve Flora picks; Sol and Astra match their standing IDs in the
current catalogue. Measurement card identities remain exact.

## Flora Pilot

Sebastian's October 30, 2026 SETUP-1B decision governs Flora. Sonnet implements UI with Sol backup. Opus handles concepts, refinement, and UI plans. Sol handles other implementation with no automatic alternate. Elevation uses a separate Sonnet session with no Opus escalation. Non-UI planning uses Astra with UNCALIBRATED trust.

The [Flora profile](policy/flora/README.md) records approved routes, role policy, board conditions, and Decision 1 usage records. Other projects retain their current routes. Field outcomes never promote these cards.

## Who does what

| Work type | Default | Also measured | Card | Card status |
|---|---|---|---|---|
| Everyday building | **Muse Spark** | Opus 5.5 | `tasks/implementation.mjs` | `UNCALIBRATED` |
| Demanding work | **`opus`, extra-high effort** | None | none yet | None |
| Flora UI implementation | **`sonnet`; Sol backup** | No quality comparison yet | `flora-ui-builder` | `UNCALIBRATED` |
| Flora concepts, refinement, UI plans | **`opus`, provider default effort** | No automatic fallback | `flora-designer` | `UNCALIBRATED` |
| Other projects: UI work | **`opus`, extra-high effort** | None | none yet | None |
| iOS work | **`opus`, extra-high effort** | None | none yet | None |
| Architectural decisions | **`opus`, extra-high effort** | None | none yet | None |
| Recovery after repeated failures | **`opus`, extra-high effort** | None | none yet | None |
| Bug fixes | candidates: **`sonnet`, GPT-5.6 Luna** | None | `tasks/bug-fix.mjs` | `UNCALIBRATED` |
| Code review | rotate candidates (see below) | Opus 5.5, Sonnet 5.5, DeepSeek V4 Pro | `tasks/review.mjs` | `UNCALIBRATED` |
| Quick, well-scoped edits | **Muse Spark** (everyday builder) | GPT-5.6 Luna | `tasks/quick-edit.mjs` | `UNCALIBRATED` |
| Semantic judgement in scoring | **Jev** | None | `scripts/jev.check.mjs` | not run on these tasks |

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
