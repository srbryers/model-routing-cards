# Flora Pilot Routing

Sebastian's October 30, 2026 SETUP-1B decision replaces Flora UI implementation on Opus at extra-high effort with Sonnet and Sol backup. Opus retains concepts, refinement, and UI plans. This profile applies only to the Flora pilot.

## Latest Model Aliases

Default standing model picks to the latest alias accepted by their provider path. On Claude Code, the latest aliases are the bare names `opus` and `sonnet`. On 2026-10-31, the coordinator's subscription probes resolved them to `claude-opus-5-5` and `claude-sonnet-5-5`, respectively. The API returned 404 for both `opus@latest` and `sonnet@latest`. See [the run record](../../RESULT-LATEST.md) for the probe results.

Astra and Sol retain their fixed Codex account IDs because the local catalogue offers no latest tags. Luna retains `gpt-5.6-luna` and `openai/gpt-5.6-luna` for the exact-identity tests and stale-identity guard. Muse Wonder retains its strict platform identity pin in `scripts/flora.mjs`. Jev already uses `jev-latest` and keeps its identity hold. Card identities remain exact measured-model keys. See [the run record](../../RESULT-LATEST.md) for all routes and evidence limits.

## Cards

The eleven versioned cards use the existing `buildCard` fields with `version`, policy/profile hashes, `selection_basis`, and `modelConfig`. No measured model rows or recommendation are invented. All cards remain UNCALIBRATED with 30-day expiry. Static selection uses `approved_profile`; outcomes cannot promote trust.

| Card | Route | Fallback |
|---|---|---|
| flora-planner | Astra through Codex | Wait; trust uncalibrated |
| flora-designer | Opus through Claude Code | Wait for Claude |
| flora-ui-builder | Sonnet through Claude Code | Sol through Codex |
| flora-general-builder | Sol through Codex | Wait or resume Sol |
| flora-review-claude | Sonnet through Claude Code | Hold for Roman |
| flora-review-codex | Luna through Codex | Hold for Roman |
| flora-ui-elevation | Sonnet, separate design session | Wait; no Opus escalation |
| flora-judge | jev-latest, TypeSafe adapter | Identity hold |
| flora-sim-runner | Sol through Codex | Wait; code-only scripts may continue |
| flora-sim-persona-judge | jev-latest, TypeSafe adapter | Identity hold; affected sim gate exits 2 |
| flora-orchestrator | Muse Wonder through the Muse platform agent | Wait for Roman's own Muse session |

The approved plan's eleven basenames are retained. `flora-backup-builder` aliases `flora-general-builder`; UI backup is also explicit in `flora-ui-builder`. `flora-router-reconciler` aliases `flora-orchestrator`. Router policy selection itself uses deterministic code. Jev's family identity is explicitly unconfirmed. Both semantic cards remain blocked until a separate identity record closes that gap.

Sebastian's October 31, 2026 decision assigns the orchestrator seat to Muse Wonder, the Muse platform agent. Setup 1b never named an orchestrator route. The earlier Sonnet entry came from PLAN.md's proposal.

The orchestrator uses provider default effort on the Muse platform. Other roles use provider default effort because SETUP-1B specifies no effort level. This does not preserve the older extra-high UI implementation default. `modelConfig.origin` carries the source, decision date, and scope.

Cards stay inside this repo under `policy/flora/cards`. `node scripts/flora-cards.mjs` rebuilds them without calls. User card stores were not written. Task modules provide briefs and evidence requirements; they refuse provider execution pending an approved role calibration harness. They do not claim completed semantic scoring or labelled calibration fixtures.

## Role Policy

`role-policy.json` is model-agnostic. Concrete IDs exist only in `profile.json` and cards. A route and every fallback must pass the class, vendor, and provider allowlist.

| Stage Role | Model Class | Vendor | Prohibitions |
|---|---|---|---|
| Non-UI planner | strategic-planner | OpenAI | No automatic alternate |
| Designer and UI planner | design-lead | Anthropic | Claude Code only; no automatic alternate |
| UI builder | implementation-review or implementation-actor | Anthropic or OpenAI | No other class, vendor, or provider |
| General and backup builder | implementation-actor | OpenAI | No automatic alternate |
| Claude board seat | implementation-review | Anthropic | Author sessions excluded; receipt required |
| Codex board seat | independent-review | OpenAI | Author sessions excluded; receipt required |
| UI elevation | implementation-review | Anthropic | Separate session; no design-lead escalation; cannot count as a board seat |
| Semantic dispute and persona judge | semantic-judge | Unconfirmed | Blocked pending family identity; no factual arithmetic or reviewer clearance |
| Persona actor | implementation-actor | OpenAI | No hidden observer facts fed to the actor |
| Orchestrator and router reconciler | orchestrator | Meta | Cannot clear taste or contract flags |

Claude never runs through OpenRouter or Pi. Gemini and Pi require Sebastian's direction and a new scoped profile. No quota, failure count, override, card winner, or paid fallback grants another route. Explicit Flora roles enter `pickFlora` before generic ranking. Generic kinds for the Flora repository return `needs_kind`. Existing classifier labels remain stable.

## Board Matrix

| Author Class | Claude Board Seat | Codex Board Seat | Pair |
|---|---|---|---|
| Sonnet | Same-model and same-vendor exception required | Different vendor | Allowed only with Decision 3 conditions |
| Sol | Different vendor | Same-vendor exception required | Allowed only with Decision 3 conditions |
| Opus | Same vendor outside approved exception author scope | Different vendor | Hold for Roman |
| Astra | Different vendor | Same vendor outside approved exception author scope | Hold for Roman |
| Luna, defensive case only | Different vendor | Same-model and same-vendor exception required | Allowed only with Decision 3 conditions; no implementation permission |
| Mixed Sonnet, Sol, or Luna repairs | Exception checked against every author | Exception checked against every author | Allowed only with complete history and Decision 3 conditions |
| Mixed history containing Opus or Astra | Recompute all authors | Recompute all authors | Hold for Roman |

Luna never reviews Sol-authored work without the named `flora-decision-3-2026-10-30` exception. It needs `SETUP-1B:Decision-3`, Flora pilot scope, and an unexpired host approval. Both reviewers use fresh sessions, isolated context, read-only access, and sealed initial reports. Exact author and repair sessions are excluded, including UI elevation sessions from correctness seats.

The host checks a feasible pair before author dispatch and each review call. It binds full authorship, sessions, models, providers, card identity, commit, contract, and both policy hashes. `validateBoard` checks both assignments together. A host callback must verify the signed receipt over this binding; the default verifier rejects every receipt.

Approval lifetime is supplied by Roman's authority record, never invented here. Any missing field, invalid signature, changed history, unavailable seat, or mismatch returns `awaiting_approval`, owner Roman, and `callsAllowed: 0` before calls. No third vendor or expensive fallback is selected. Sealed-report storage and per-call enforcement require setup step 7 integration tests.

## Usage Records

Decision 1's amendment requires a version 1 pool snapshot at dispatch and every round boundary. `pool-state.example.json` shows Claude session/weekly headroom and Codex shared-account credits/plan limits. Values carry source and unit; null means unavailable. Codex, Work, and ChatGPT share that account. Subscription cost stays null with source `unknown`. Calls, tokens, and occupancy time belong in live job outcomes when available.

A routing decision entry requires `version`, `id`, `at`, `jobId`, `round`, `kind`, `route`, `previousRoute`, `boundary`, `reason`, `basis: policy`, `selection_basis: approved_profile`, `policyHash`, `profileHash`, and `poolState`. The snapshot timestamp equals the decision timestamp. `validateRoutingDecision` rejects missing pool state and route changes outside round boundaries. A new snapshot and decision are required even when the route stays selected.

Only eligible routes compete. Routes count as quality-equal unless records for the job class show a measured difference. The caller's `qualityEqual` flag is ignored. Prefer more live headroom relative to expected job draw by default. Sol goes first where a measured headroom difference does not settle the choice. If the headroom picture inverts, a route may change at the next round boundary with a recorded reason. Unknown dollar costs never become estimates. Availability and expected draw come from the host, not invented values here.

The existing `outcomes.jsonl` records supply per-route pass rates for the job
class. Corrections use append order. Pass, partial, and fail results form the
denominator; only pass results form the numerator. Abandoned results are excluded.
Sebastian's October 31, 2026 sample-floor ruling requires at least 3 measured outcomes per eligible route before a difference can apply. Below that floor, quality counts as equal and the cheaper live route wins. These field
rates describe recorded jobs, not controlled calibration, and never promote trust.
If outcome coverage is incomplete, fresh card measured rows for both routes can
supply `score_mean`, subject to the 3-sample floor per eligible route. No new quality store is used. Missing or equal measurements
leave the cheaper-route rule in effect. A measured difference selects the route
with the higher score before headroom is considered.

Decisions retain eligible routes, headroom/draw ratios (null when unavailable),
the quality source and measurements, whether a difference applied, and the winner.
`quality.sampleFloor` records `minimum: 3`, `countsByRoute`, and `applied`.
Counts use the selected measurement source, or available outcome counts when coverage is incomplete.
The validator rejects missing or inconsistent floor fields in decision receipts.

`pickFlora` returns a static selection receipt with pool state and no spawn. Missing snapshots return `needs_pool_state`; no eligible route returns `waiting_capacity`. Jev returns `blocked_identity`. `recordOutcome` validates Flora decisions and copies their pool state into outcomes. Existing outcomes remain compatible. Live capture, pool pacing, round transitions, append-only decision writes, and provider launch into the Taura scheduler are setup step 8. No live hookup is claimed here.

## Offline Checks

- `npm test` checks the live card set first, then runs the repository tests.
- The dated `routing-decision.example.json` retains its earlier profile hash. Checking it with `node scripts/flora.check.mjs --decision policy/flora/routing-decision.example.json` must reject the stale binding. Tests bind an in-memory copy to the current profile before checking its shape.
- `npm run check:flora` emits card, profile, and policy hashes with zero provider calls.
- `node scripts/flora.check.mjs scripts/fixtures/flora-stale-luna.card.json` must exit 1 before provider calls.
- Historical measurements and the dated pre-overlay policy fixture remain untouched. Old Luna receipts must be quarantined, never relabelled as evidence for the repaired identity.
