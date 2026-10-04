# Routing policy

Choose the cheapest capable tier, then the provider with the most quota headroom.
`policy.json` is the active policy; `routing-profile.md` is the earlier draft and
its open questions. Benchmark evidence does not change policy by itself.

- **Route:** a worker to run, or an outside instruction to follow.
- **Pool:** quota shared by one or more routes.
- **Tier:** a cost and capability level.
- **Kind:** the category assigned to a task.
- **Candidate:** an eligible route offered for selection.
- **Fallback:** the next route to try when the first choice is unavailable.
- **Basis:** the reason a route was chosen: policy, trial, card or card-cheaper.
- **Trial:** a choice between tied routes that rotates each time, so each gathers evidence.
- **External route:** work handed to a tool outside the worker pool, with an instruction instead of spawn arguments.
- **Override:** a repo's own rule that replaces the shared policy for some kinds of work.

| Section | Meaning |
| --- | --- |
| `routes` | `bb` routes have provider/model IDs, machines and caps. `external` routes carry an instruction and spend-approval flag, with no spawn fields. Both identify vendor and pool. Pi's liveness command is never run by the loader. |
| `pools` | Subscription, local and metered pools, readable quota windows and provider restrictions. |
| `tiers` | Ordered routes, fallbacks and default reasoning for each paid tier. |
| `kinds` | Fixed classifier labels, descriptions, tier, reasoning and explicit route order. `local` and `image` are outside paid tiers. `null` reasoning means no effort setting. |
| `escalation` | `failuresScope: "task"` counts total failures across tiers. Every two failures advance one step: 1 → 2 at high, then 2 → 3 at xhigh. Stop at tier 3; local and image have no escalation step. |
| `quota` | Strict **greater-than** used-percent thresholds, five-hour Muse cooldown, tier preferences, pool reservations and `ceilingPercent`. The 70% and 85% thresholds are soft: they steer work between subscriptions and never stop it. The Claude 80% reservation and the ceiling are hard. A lone preference binds when its target pool is available; reservations always bind. |
| `quota.ceilingPercent` | A number from 50 to 100 (now **95**). A pool with any readable window **at or above** the ceiling is exhausted: every route in it is removed, as a cooldown would remove it. `why` says so, for example `codex weekly 96% ≥ 95% ceiling: pool exhausted`. |
| `tieBreak` | Tier 2 is Sonnet, Astra or Sol: repo rule, machine eligibility, weekly pace picks the pool, then the pool picks the route (Sonnet; or Astra and Sol alternating; or all three when the pools tie). Alternating choices are labelled `trial`. `routes` lists the rotation order and must all be tier-2 candidates. Sol runs on both machines. |
| `review` | Review kinds require a different vendor from the author. |
| `cards` | `byKind` maps kinds to card files. Fresh `CALIBRATED` winners may select an allowed candidate; measured cheaper results can break a pace tie. The 30-day limit matches `TRUST.STALE_DAYS`. |
| `classifier` | `minProbability: 0.6` and `minMargin: 0.15` decide when Jev must defer. Both are validated from 0 to 1. |
| `fieldEvidence` | Outcome counts needed to justify a real bake-off. Never used for route selection or card trust. |
| `machines` | `default` names the preferred machine; other entries are machine IDs with descriptions. |
| `repos` | Public repo rules keyed by lowercase GitHub `owner/name`; each has `rules` and optional `machines`. Empty in this repo. Your own rules go in the [local overlay](#local-overlay). |

## Change the policy

1. Edit the JSON and update `updated`. Keep kind IDs stable; each description is
   read by the classifier. Keep descriptions short and plain, and make sure no two
   kinds claim the same work. Jev reads only the descriptions, so write the
   precedence into them: domain kinds (`ios`, `ui-visual`, `3d-work`, `data-contract`,
   `user-facing-copy`) win over `quick-edit`, `bounded-build` and `multi-step-coding`,
   but tests-only work is `write-tests` in any codebase, including iOS; `migration` wins over `multi-step-coding`;
   the higher-risk review kind wins; a bug whose cause must be found is
   `hard-bug-fix`, even if it reproduces. After changing one, run
   `node scripts/classify.check.mjs --execute` (17 live Jev calls, capped at $0.05).
   Without `--execute` it only lists the briefs. Kind candidates and fallbacks must belong to their paid tier. An exception
   requires `crossTier: true` and a nonempty `crossTierReason`; local/image kinds
   declare these explicitly. External routes cannot appear in paid tiers.
2. Keep route references valid. Muse is Mac-only, contributor models are forbidden,
   Claude model/provider/pool/vendor must agree, as must Codex and Muse provider/pool
   pairs. Sonnet accepts xhigh but never max. Routes in `tieBreak.routes` must be tier-2 candidates.
   Sol (`gpt-6.1-sol`) runs on the Mac Studio and the PC; it needs Codex CLI 0.160 or later. BB lists it with
   `ultra` as well, which policy never requests. A route with provider `pi` (including every Fireworks route)
   must not list `pc`: BB's Pi extension fails on Windows with "Unsupported fd type: UNKNOWN", and the validator rejects it.
3. Run `npm test`. The loader rejects unsupported versions, unknown fields and
   invalid references and duplicate JSON keys. A format change needs a new
   supported `policyVersion`.

## Repo overrides

Repo rules come from three places. `policy.json` ships with none (`repos: {}`).
Your own rules for your own repos go in the [local overlay](#local-overlay), so
no files need to be added to those repos. A repo can also carry its own
`.model-routing.json` at its root (`examples/` has one generic sample):

```json
{
  "policyVersion": 1,
  "machines": ["pc"],
  "rules": [
    {
      "kinds": ["bounded-build"],
      "route": "luna",
      "reasoning": "high",
      "source": "AGENTS.md",
      "why": "This repo uses Luna for bounded implementation tasks."
    }
  ]
}
```

`machines` and each rule's `reasoning` are optional. `rules` may be empty. A rule
needs `kinds`, `source`, `why`, and at least one of `route`, `excludeRoutes`, `note`.
`kinds: ["*"]` targets every kind; do not mix `*` with named kinds. A specific
route rule wins over a rule that covers every kind (`kinds: ["*"]`) within the same source. All matching
exclusions accumulate across both sources; a file cannot re-enable an excluded
route. Exclusions that remove every applicable route are invalid. Route IDs
and exclusion entries must be strings. Matching notes are deduplicated and joined into each candidate's `note`.
Machine precedence is file → repo entry (local overlay, else public) → all policy machines. A supplied
list replaces the inherited list and restricts every candidate. Each kind may
appear in only one rule within each source. Source paths only name where a rule came from; they are never
read as files. An override route must run on at least one allowed repo machine.

For each kind, order is **repo file → `repos[owner/name]` → tier rules**, where
`repos[owner/name]` is the local overlay entry if there is one, otherwise the
public entry. A file rule wins over an entry rule for that kind; unmatched kinds
keep the entry's rules. An empty file does not erase entry rules. Lower-priority routes remain as
fallbacks. After two failures, repo/file routes remain first but are marked
`escalated: true`, followed by the escalated tier candidates minus excluded routes.
`--failures` counts total failed attempts on the task: apply
`floor(failures / escalateAfterFailures)` steps, stopping at tier 3. Quick-edit
uses tier 2 after two failures and Opus at xhigh after four or nine. A tier-2
kind reaches tier 3 after two failures. Their effective tier becomes the final
escalated tier. `pick` skips escalated repo/file
preferences, including at tier 3 where no higher tier exists. Tier 3 has no next tier. Reasoning defaults to the kind's
effort (or escalated effort), capped by the route; an explicit effort above a cap
is an error. Machine limits and Muse's skill-workflow exclusion still apply.

⚠ A repo preference cannot create quota. `pick` reports an override blocked by
quota, tries eligible fallbacks, then stops if none remain. Conflicting
soft preferences are discarded in favor of pace; they do not block. Likewise, a review override
cannot bypass the different-vendor rule; stop if no eligible reviewer remains.

## Local overlay

Personal repo rules and personal wording live in
`$XDG_CONFIG_HOME/model-routing/policy.local.json`, defaulting to
`~/.config/model-routing/policy.local.json`. The file is not tracked and you manage it
yourself. `policy/examples/policy.local.example.json` is a generic sample. `loadEffectivePolicy` merges
it into the public policy at load, and `pick`, `limit` and `outcomes` all use the result.

| Key | Effect |
|---|---|
| `policyVersion` | Required. Must be `1`. |
| `repos` | Same shape as `policy.repos`. An entry **replaces the public entry for the same key as a whole**; its rules and machines are not merged. |
| `routes` | `{ "<route>": { "note": "..." } }`. Sets that route's `note`, replacing any public note. Not for external routes. |
| `kinds` | `{ "<kind>": { "description": "..." } }`. Replaces only the description, which Jev reads when classifying. |
| `instructions` | `{ "<external route>": "..." }`. Replaces the instruction text of an external route. |

An overlay cannot add routes or kinds, or change tiers, quota, pools, machines,
reasoning caps or any other hard rule. Unknown keys are errors. The merged policy
goes through the same validator as the public file, so a repo rule that names a
missing route, or breaks the Muse and review rules, is rejected.

A missing file is fine. An unreadable, malformed or invalid file stops the command
with exit code 2 and the file path plus each error. It is never ignored, because
it changes routing. (`local.json` disables only the Pi route when it is bad; an
overlay rule can touch any route, so there is no narrower thing to disable.)

Precedence for a repo's rules, highest first:

1. the repo's own `.model-routing.json`
2. the local overlay entry for that repo
3. the public `policy.repos` entry

Replacement is per repo key. Lower sources stay as fallbacks behind a higher
source's route, as with any other repo rule.

Commands:

- `model-routing policy show [--json]` prints the merged policy summary and which
  files were loaded (`policy.json`, `policy.local.json`, `local.json`).
- `model-routing policy export-local --from OLD.json` prints an overlay built from an
  older policy file: all its `repos`, plus any `routes` notes, `kinds` descriptions
  and `instructions` that named a person. It exports a text field only when the old
  text equals the current public text with each "the user" replaced by a name; anything
  else must match exactly. A field that looks name-bearing but also differs is not
  exported; stderr lists it as `differs for other reasons: <field path>` to check by hand.
  It prints only; redirect it yourself: `model-routing policy export-local --from
  old.json > ~/.config/model-routing/policy.local.json`. It checks the result against
  the current policy before printing.

## API boundary

- `loadPolicy(path?)` synchronously reads, validates and deeply freezes the public policy.
  Its default path is relative to the module, independent of the working directory.
- `loadEffectivePolicy({ env, readFile, publicPath }?)` from `model-routing-cards/policy-local`
  returns `{ policy, sources, effects }`: the public policy merged with the local overlay,
  validated and frozen. It throws a `TypeError` naming the overlay path when that file is
  unreadable or invalid. `validateOverlay(overlay, policy)` and
  `exportLocal(oldPolicy, currentPolicy)` are pure.
- `loadOverride(repoDir)` does the same for the repo override against the default
  policy; only an absent file returns `null`. For a custom policy, pass parsed
  override data to `validateOverride(override, policy)`.
- Both validators return `{ ok, errors }`. `kindsForClassifier(policy)` returns
  `{ id, description }` entries.
- `repoKey(repoDir, { execFile }?)` reads only `git remote get-url origin`, without
  network or a shell. The Git call is injectable. Pure `parseRepoUrl(url)` accepts
  GitHub SCP, HTTPS and SSH URLs and returns lowercase `owner/name`; other hosts
  return `null`. A missing origin or non-repo also returns `null`; other Git errors
  propagate. SSH-config host aliases such as `github.com-work` give no repo key,
  so no repo rules apply. Pass the key to the resolver; it does not detect repos itself.
- `resolveCandidates(policy, kind, { repo, override, machine, failures, localConfig })` returns
  `{ candidates, blocked }`. It lowercases `repo`, strips `.git`, and rejects invalid
  `owner/name` values. Candidate fields are:
  `{ route, type, provider, model, reasoning, machines, pool, vendor, tier, source,
  fallback, escalated, reason, instruction?, requiresSpendApproval?, costPer1M?, note? }`.
  `source` is `kind`, `tier` (after escalation), `repo` or `file`. `tier` is the
  effective kind/escalated tier, including for repo/file preferences. `fallback`
  marks declared fallbacks and candidates behind a higher-priority preference.
  External candidates use null provider/model/reasoning and an empty machines
  list; they retain their instruction and approval flag. Their rules cannot set
  reasoning. Matching rule notes are retained in optional `note`.
- `blocked` contains `{ route, why }` for each dropped candidate: exclusion, machine
  limit or superseded source. A duplicate's lower-priority occurrence can be
  blocked while its preferred occurrence remains a candidate. An empty candidate
  list always includes a blocked explanation. Inputs are never mutated.

`resolveCandidates` also accepts `reviewFallbacks: true`. It appends the nearest
tiers after the usual candidates, keeping the same repo exclusions and machine
limits. `pick` requests this only when the author-vendor rule removes every
candidate. Equal tier distances favor the higher tier. The task's effective tier
still governs quota; reasoning comes from the fallback tier and route cap.

## Pick decisions

`pick(input, deps)` is pure. Policy, override, normalized repo key, quota, cards,
classifier result, local model config, time, decision ID, alternation history and limits arrive through
`deps`. The CLI reads them and logs the result. The worker adapter owns quota
normalization and spawn argument construction. `--execute` enables only Jev
classification; dispatch stays with the caller.

| Decision | Rule |
| --- | --- |
| Kind | `--kind` wins. Otherwise one Jev Choice over `kindsForClassifier` plus `unknown`, with state `{ brief }`. The request shape follows the [TypeSafe Choice contract](https://docs.typesafe.ai/primitives/choice). |
| Uncertainty | Unknown, malformed or unavailable answers return `needs_kind`. Retain up to three real kinds with valid probabilities; never invent probabilities for malformed responses. `confidence` retains Jev's confidence; thresholds use option probabilities. |
| Budget | Call `assertJevBudget` before credentials and request. Default cap is $0.01. The serialized UTF-8 request byte count bounds input tokens for the reserve. Keep the 80,000-byte rejection. Key/configuration errors exit 2 before the network request. Log measured input cost; use null when response usage is unavailable. Oversized requests are rejected, never truncated. |
| Machine | Explicit flag, then a sole allowed repo machine, then `machines.default` if allowed, otherwise the first allowed machine. Conflicts block. `default` is validated and never treated as a machine ID. |
| Cooldown | Skip limited routes, then use the surviving policy candidates. `limit` defaults to the route's policy duration, otherwise five hours. |
| Quota rules | When exactly one threshold triggers, Claude session >70% excludes Claude for tier 2, or Codex weekly >85% excludes Codex for tier 2. Remove that pool before repo/card selection and report blocked repo/file rules. Stops act on pools, so Sol follows Astra: Claude session >70% leaves Astra and Sol to alternate; Codex weekly >85% removes both and leaves Sonnet. If the target pool has no allowed candidate, retain the other pool with a fallback note. If both trigger, discard both preferences and choose by pace, with a note. Above 80% Claude session usage still reserves Claude for tier 3 or main threads; the fallback cannot bypass this reservation. At or above `quota.ceilingPercent` (95), a pool is exhausted whatever the other rules say, even for main threads and repo rules. |
| Pace | `elapsedPct = 100 * (now - (resetsAt - length)) / length`; headroom is elapsed minus used. Weekly length is seven days; session length is five hours. Require a `Z` or explicit UTC offset, clamp elapsed to 0–100, compare full precision and show both headrooms. Ignore windows with a `model` field; duplicate kinds use the highest used percentage. |
| Tie | `tieBreak.marginPoints: 5`, validated from 0 to 100. Pace compares the Claude and Codex weekly windows. If the larger headroom beats the smaller by more than the margin, that pool wins. Claude wins: Sonnet, `basis: policy`. Codex wins: Astra and Sol have no evidence between them, so they alternate, `basis: trial`. A difference at or below the margin rotates over every allowed tier-2 route (Sonnet → Astra → Sol → Sonnet), starting with Sonnet. Missing weekly data also rotates. When only one pool is allowed (for example after a quota stop), its routes alternate. Sol is allowed on both machines, so the PC rotates the same way. |
| Missing quota | Failed reads or missing/invalid/expired windows are unknown, never zero usage. Notes say “quota unknown: hard stops not applied”; valid remaining windows still impose their stops. `--require-quota` checks only pools marked `readable: true` (Claude and Codex). Check the selected pool, plus both pools when the tier-2 choice uses pace or a quota preference. Unused fallback pools do not count. Unreadable pools such as Muse and local never block for quota; `why` says they rely on cooldowns. External instructions need no worker quota. |
| Review | Exclude the author's entire vendor. If every candidate is excluded, try the nearest different-vendor route with the same machine, exclusion, cooldown and quota checks. |
| External | Return the instruction and spend-approval flag, with no spawn arguments. Worker cards cannot bypass an external instruction. |

`cards.byKind` values are basenames such as `implementation.card.json`.
Search `--cards-dir`, `MODEL_ROUTING_CARDS_DIR`, `<repo>/tasks/runs`, then
`$XDG_DATA_HOME/model-routing/cards` (default `~/.local/share/model-routing/cards`).
The first present file wins the lookup; if malformed, unreadable or for another
task, ignore it with a reason rather than silently using a lower-priority file.
The card's `task` must equal the basename minus `.card.json`.
The installed package is not a card store. `card --out DIR` writes to a user store.
Absent files are reported in `why`.
The mapping is quick-edit → quick-edit, both bug-fix kinds → bug-fix, bounded-build
and multi-step-coding → implementation, and all review kinds → review.

Each worker route can declare unique `cardModels` aliases. These match the exact
model IDs in task cards, including `meta/muse-spark-1.3`,
`anthropic/claude-sonnet-5.5`, `anthropic/claude-opus-5.5` and the existing task slug
`openai/gpt-6-luna` for the Luna route. Sol uses `openai/gpt-6.1-sol`, the same slug style. Aliases are explicit policy mappings;
changing a route model needs review of its aliases and existing measurements.
The metered DeepSeek route has no card alias; existing DeepSeek measurements do not establish it as a winner.

A card never displaces a repo/file rule. If the first allowed candidate comes
from either source, `why` says “repo rule outranks card”. Otherwise cards may
choose only candidates whose source is `tier` or `kind`, including a resolved
fallback, and only when
`CALIBRATED` and strictly younger than `cards.maxAgeDays`. Future dates, stale
cards, `UNCALIBRATED`, `SINGLE_CANDIDATE` and disallowed winners are ignored with a
reason. A fresh `NO_CLEAR_WINNER` may choose `card-cheaper` only within a pace tie,
when both candidates have measured, comparable cost per accepted result and the
recommended one costs less. Null subscription costs cannot break a tie.

The redundant `quota.allLimited` section was removed. The explicit `bulk-text`
candidates define its local choice. Numeric tiers may offer a metered fallback after subscription limits; otherwise no candidates left means blocked. Pi is
available only on Mac Studio and needs a configured model. `pick` returns a plan
with `beforeSpawn` steps the caller must complete before running `spawn.argv`.
Pi includes “Check the local server is running” followed by the policy’s curl
command. Null reasoning omits both the flag and its `spawn.missing` entry.
Repo review gates stay in `notes`, because independent review can happen after
implementation rather than before worker startup. It does not run the liveness command or add network
probes to a dry pick. Image work names Codex image tooling; `pi-imagen` is a tool
note, not an additional worker route.

## Local model configuration

The public Pi route has `"model": null, "modelFrom": "local"`. Store its model
only in `$XDG_CONFIG_HOME/model-routing/local.json`, defaulting to
`~/.config/model-routing/local.json`. This file is outside the repository and is
not tracked. For example, replace the placeholder locally:

```json
{
  "routes": {
    "pi-local": { "model": "your-local-model-id" }
  }
}
```

The CLI reads this optional file without creating or changing it. It may supply
only a nonempty `model` for a route explicitly marked `modelFrom: "local"`.
Unknown routes, other fields, invalid JSON and contributor models are rejected.
An absent file or absent route is allowed: the resolver drops Pi with
`pi-local model not configured in local.json`, then uses eligible fallbacks.
Malformed, invalid or unreadable configuration disables only routes marked
`modelFrom: "local"`. Their `blocked` reason names the full config path; unrelated
picks continue. Loader diagnostics never echo file contents. If bulk text moves
to a cloud fallback, the decision says not to send private text; it does not block.

`loadLocalConfig(policy, { env, readFile })` reads and validates the file;
`validateLocalConfig(config, policy)` is pure. Tests and library callers can pass
parsed `localConfig` to `resolveCandidates` or through `pick` dependencies.
On file errors, the loader returns empty `routes` and an `error` string. The CLI
passes it as `localConfigError` to the pure resolver/picker. Local settings do not
modify the shared policy, and no liveness command runs here. The resolved local
model ID appears in stdout and in the user's decision log, outside the repo.

## Supported reasoning

Routes may declare `supportedReasoning`, a unique array drawn from
`none`, `low`, `medium`, `high`, `xhigh`, `max`. An empty array means no reasoning
setting; omit the flag and do not list it as missing. Omitted declarations retain
the existing kind level and route cap. A null kind level also omits the flag.

For a declared list, map the requested kind/rule level to the nearest supported
level in that order. Ties go up: medium becomes high with only low/high support.
Apply this to every declaring route, not just paid ones, and record adjustments
in the reason. Declarations cannot exceed a route's cap. `none` is an explicit
supported setting, distinct from no setting (`[]`).

The Fireworks declarations come from the local Pi model catalog. Kimi and GLM
support low/high/max; DeepSeek supports none/low/high/max; MiniMax and GPT OSS
support low/medium/high; Qwen supports none/low/medium/xhigh. The two disabled
OpenRouter Gemini models are absent from the current local catalog, including
selected-model queries. Their levels remain unclaimed; adding a verified
`supportedReasoning` declaration is required before enabling a metered route.

## Metered routes

The `metered` pool bills per token. Its Pi and acp-gemini workers are Mac Studio only;
Pi routes (including Fireworks) because BB's Pi extension does not start on Windows,
acp-gemini because it is only tested there. They do not
have readable subscription quota. Cooldowns still apply. Vendor identity stays
independent of provider: `fw-gpt-oss-120b` is OpenAI and cannot review
OpenAI-authored work. Claude still requires its Claude provider and pool.

| Field | Meaning |
|---|---|
| `costPer1M` | `null` for wholly unknown prices, or `{ "in": number or null, "out": number or null }`, USD per million input/output tokens. Numbers must be finite and nonnegative. Null means unknown, never free. Required on metered workers. |
| `requiresSpendApproval` | Must be true on metered workers. |
| `disabled` | Optional nonempty reason. Resolver always drops the route and puts that reason in `blocked`. |
| `quota.meteredFallback` | Ordered route IDs keyed by effective tier: tier 1 uses DeepSeek Flash then MiniMax; tier 2 uses Kimi then GLM; tier 3 must be empty. |

Automatic paid fallback requires every subscription candidate to have been
removed by the 95% ceiling or by a cooldown (a `limit` set after a provider limit
error). The Claude 80% reservation is not enough: if a subscription is held back
only by that reservation and every other subscription is exhausted, `pick`
returns `blocked` with the reason and offers no metered route. The owner decides.
Any removal for exclusion, machine,
missing local configuration, review vendor or an escalated repo rule prevents
it. Duplicate candidates superseded by a repo/file preference are not removals.
The fallback resolver still applies repo exclusions, machine limits, disabled
routes, vendor rules and cooldowns. Ordinary repo notes do not prevent fallback.
This conservative rule never uses spending to bypass routing restrictions.
Tier 3 stops when limited; local and image kinds have no automatic paid list.
The order is unmeasured and no card backs it, as `why` states. Cards cannot
reorder an automatic paid fallback. Subscriptions always stay ahead of it.
A repo/file rule may explicitly select a metered route, subject to the same
eligibility checks. This is intended and is not governed by the ceiling. The
95% ceiling controls only the automatic metered fallback. A repo rule that names
a model no subscription offers (for example `gemini-flash`) is a
deliberate choice, so it is offered even while subscriptions have room. It still
needs spend approval: the result is `needs_approval`.

Chosen metered workers return `status: "needs_approval"` and exit **5**, including
`approval: { spawnArgv, costPer1M, route }` and `spawn: null`. The preview is for
review, not dispatch. Re-run pick with `--spend-approved <route>[,<route>...]` to
get an `ok` decision and runnable `spawn.argv` only when the selected route is
listed. A bare flag exits 2 and asks for the approved route. Unknown IDs and empty
list entries are usage errors; surrounding spaces and duplicate IDs are normalized.
A changed paid selection returns `needs_approval` again and explains which routes
the approval covers. The decision log stores `approvedRoutes`, selected `route`
and the `spendApproved` boolean. This changes the boolean flag from PR #12.
Approval is not a price cap: null means unknown, not free. Pass only route IDs
whose spend the user approved or whose task brief already grants it.
External routes keep `status: "external"` and their existing approval behavior.
Approval is a statement by the caller; pick does not dispatch or bill anything.

Both OpenRouter Gemini routes are disabled because the account has about $0.21
and calls return 402. A matching repo/file rule adds a prominent disabled-route
note as well as an alternative rejection. Top up, verify and declare their
supported reasoning, then remove their `disabled` fields. They remain behind the
acp-gemini options; no Gemini subscription route is configured.

`gemini-pro`, `gemini-flash` and `gemini-flash-lite` use `acp-gemini`, running
Gemini CLI on Vertex AI and billing per token to a Google Cloud project. They use
Google's native model IDs, vendor `google`, pool `metered`, Mac Studio only and
`supportedReasoning: ["medium"]` (managed by the agent). Provider and native
Gemini model identity must agree with that vendor/pool in both directions.
External tools and OpenRouter-qualified models retain their separate providers.
`costPer1M` is null because Vertex prices are unverified. Route notes give past
OpenRouter Flash $0.75/$3.75 and Pro $2/$12 per million input/output tokens as a
reference only, never as Vertex prices. Skip `auto` because its choice is unstable
and `gemini-2.5-pro` because it is an older line.

These are Gemini-specific choices, not general coding fallbacks; they are absent
from `quota.meteredFallback`. A repo can route `visual-implementation` to
`gemini-flash`; the global default remains tier-3 Opus. That suits narrowly
scoped visual work, with Astra reasoning and directing. The unused external
`gemini-visual` route was removed. A repo whose own instructions require a drafting
script for copy can keep `user-facing-copy` on external `gemini-copy`.
The rule format supports one preferred route, so an optional `gemini-flash`
drafting path is a note, not a second candidate.

## Field evidence

```json
"fieldEvidence": {
  "minOutcomesPerRoute": 5,
  "minRoutes": 2
}
```

Both fields are required integers. `minOutcomesPerRoute` must be at least **1**;
`minRoutes` must be at least **2**, because a head-to-head needs two routes.
Unknown fields are rejected.

`outcomes` groups logged decisions by kind and route. It shows decisions, latest
recorded outcomes, pass/partial/fail/abandoned counts, and separate basis counts
for decisions and outcomes. The basis columns include `trial`, `policy`, `card`
and `card-cheaper`; card decisions are not relabeled as policy. Decisions without
a selected route do not enter the table. `--kind` filters the summary; `--json`
returns the same counts, thresholds, readiness and next steps as structured data.

A kind is ready when at least `minRoutes` routes each have
`minOutcomesPerRoute` outcomes whose result is `pass`, `partial` or `fail`.
Abandoned work stays in its own column and does not count toward readiness.
Re-recording replaces the old line in the summary, so one decision
never adds two outcomes. Last append wins, even if its timestamp is older.
If the decision log repeats an ID, both commands use its last appended decision,
including that decision's metadata and brief hash.
Readiness is shown for kinds seen in the decision log, or the requested `--kind`.

When ready, write or extend `tasks/<task-id>.mjs`, using the task ID from the
`cards.byKind` card basename, then run
`model-routing run <task> --execute`. If there is no mapping, the next step includes
adding one. This is an instruction to run a real bake-off, not a route recommendation.

⚠ Different tasks went to different routes. These outcomes are confounded, not
measurements. They stay in `outcomes.jsonl`, apart from bake-off receipts.
`card.mjs`, `route.mjs` and the card logic in `pick` never read them. Outcome counts,
gate facts and optional Jev probabilities cannot change card trust or selection.

The main thread records after verification. Gates come only from code via flags
or a JSON object of `"pass"`/`"fail"` values. Jev can separately check whether the
result meets the matching brief, after budget approval. It supplies no factual
gates and does not override the recorded result. Missing model or usage data is
stored as `null`, never invented or treated as free. Text and credentials are not
stored; notes are limited to 500 characters and must not contain secrets.
The brief must fit within 40% of the 80,000-character text budget or the check is
refused. The result uses the remaining budget, keeping its beginning and end with
an omission marker in the middle. The complete brief is always sent.

Both logs use the shared state reader and lock. Unreadable lines are skipped,
including outcomes with invalid results or bases and routed decisions with invalid bases;
the summary reports the count for each log in text and JSON. A new append starts
on its own line even when a killed writer left an incomplete final line.

## State

The decision log is also the alternation record: only logged `ok` decisions with
`basis: trial` advance that kind. The last trial is kept per kind (rotation over
three routes) and per kind and pool (Astra/Sol), so a Sonnet trial in between
does not skip a codex route's turn. A directory lock serializes pick/log and limit
updates; no lock is held during classification. Limits are atomically replaced in
`limits.json`. The `.lock/owner.json` file records PID, timestamp and ownership
token. A dead PID (`ESRCH`) or a lock older than 30 seconds permits reclamation.
A fresh live owner is waited on, up to five seconds. Reclamation rechecks the owner immediately before removal. Release uses forced
removal and checks the token so a replaced owner cannot release the newer lock. Keep
locked operations short; the 30-second lease can expire even for a live owner.
Unreadable log lines are skipped and counted in the decision notes. A truncated
last line is separated before the next append.

State is under `MODEL_ROUTING_STATE_DIR`, otherwise
`$XDG_STATE_HOME/model-routing`, otherwise `~/.local/state/model-routing`.
The brief is logged as `{ sha256, length }`, where length is JavaScript string
length (UTF-16 code units). Request/response bodies and credentials are never
logged. Runnable and approval-preview argv are omitted from the disk log to avoid retaining titles,
project/section IDs and prompt-file paths; stdout and `logDecision()`’s return
value keep it. Existing state exports and argument lists are unchanged.
`readState()` adds `unreadableLogLines` and `poolAlternation` beside `alternation`
and `limits`. Pass the policy as the second argument so routes map to pools; without
it `poolAlternation` is empty.
Policy and card explanations remain in `why`; repo notes remain in
`notes`; resolver exclusions remain in `alternatives`.
