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
- **Trial:** a choice between two tied routes that alternates each time, so both gather evidence.
- **External route:** work handed to a tool outside the worker pool, with an instruction instead of spawn arguments.
- **Override:** a repo's own rule that replaces the shared policy for some kinds of work.

| Section | Meaning |
| --- | --- |
| `routes` | `bb` routes have provider/model IDs, machines and caps. `external` routes carry an instruction and spend-approval flag, with no spawn fields. Both identify vendor and pool. Pi's liveness command is never run by the loader. |
| `pools` | Shared subscription pools, readable quota windows and provider restrictions. |
| `tiers` | Ordered routes, fallbacks and default reasoning for each paid tier. |
| `kinds` | Fixed classifier labels, descriptions, tier, reasoning and explicit route order. `local` and `image` are outside paid tiers. `null` reasoning means no effort setting. |
| `escalation` | Two failures at the current tier advance one tier: 1 → 2 at high, 2 → 3 at xhigh. Tier 3, local and image have no escalation step. |
| `quota` | Strict **greater-than** used-percent thresholds, five-hour Muse cooldown and emergency fallback. Hard stops beat overrides. |
| `tieBreak` | Tier 2: repo rule, machine eligibility, weekly pace, then alternate Sonnet/Astra and label the choice `trial`. PC allows either. |
| `review` | Review kinds require a different vendor from the author. |
| `cards` | `byKind` maps kinds to card files. Fresh `CALIBRATED` winners may select an allowed candidate; measured cheaper results can break a pace tie. The 30-day limit matches `TRUST.STALE_DAYS`. |
| `classifier` | `minProbability: 0.6` and `minMargin: 0.15` decide when Jev must defer. Both are validated from 0 to 1. |
| `machines` | Available machine IDs and their descriptions. |
| `repos` | Repo rules keyed by lowercase GitHub `owner/name`; each has `rules` and optional `machines`. |

## Change the policy

1. Edit the JSON and update `updated`. Keep kind IDs stable; each description is
   read by the classifier. Kind candidates and fallbacks must belong to their paid tier. An exception
   requires `crossTier: true` and a nonempty `crossTierReason`; local/image kinds
   declare these explicitly. External routes cannot appear in paid tiers.
2. Keep route references valid. Muse is Mac-only, contributor models are forbidden,
   Claude model/provider/pool/vendor must agree, as must Codex and Muse provider/pool
   pairs. Sonnet accepts xhigh but never max.
3. Run `npm test`. The loader rejects unsupported versions, unknown fields and
   invalid references and duplicate JSON keys. A format change needs a new
   supported `policyVersion`.

## Repo overrides

The five real repo entries live here in `policy.json`, under `repos`. No files need
to be added to those repos. For an optional local override, put
`.model-routing.json` at the repo root (`examples/` has one generic sample):

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
Machine precedence is file → central repo entry → all policy machines. A supplied
list replaces the inherited list and restricts every candidate. Each kind may
appear in only one rule within each source. Source paths only name where a rule came from; they are never
read as files. An override route must run on at least one allowed repo machine.

For each kind, order is **repo file → `repos[owner/name]` → tier rules**. A file
rule wins over a central rule for that kind; unmatched kinds keep central rules.
An empty file does not erase central rules. Lower-priority routes remain as
fallbacks. After two failures, repo/file routes remain first but are marked
`escalated: true`, followed by the next-tier candidates minus excluded routes.
Their effective tier becomes the escalated tier. `pick` skips escalated repo/file
preferences, including at tier 3 where no higher tier exists. Tier 3 has no next tier. Reasoning defaults to the kind's
effort (or escalated effort), capped by the route; an explicit effort above a cap
is an error. Machine limits and Muse's skill-workflow exclusion still apply.

⚠ A repo preference cannot create quota. `pick` reports an override blocked by
quota, tries eligible fallbacks, then stops if none remain. Conflicting
thresholds must never bounce between exhausted pools. Likewise, a review override
cannot bypass the different-vendor rule; stop if no eligible reviewer remains.

The central entries encode the supplied rules without reading other repos:

- Wedding routes only `data-contract` to Astra. Its `high-risk-review` note says
  "data-contract reviews go to OpenAI (AGENTS.md)" without rerouting other reviews.
- Fathoms Game restricts all candidates to PC and uses Astra for its four listed
  review/reasoning kinds.
- Flora Studio uses Astra for `3d-work` and Luna for both ordinary review kinds.
  Classify 3D review as `3d-work` to preserve its all-3D rule.
- Prelude has explicit copy, visual, image, implementation and review rules; a
  note covering every kind preserves Gate 5 independent review for every kind. The routine
  review, multi-step coding, UI and architecture mappings are Sebastian's readings
  of the repo role list, not verbatim rules; their `why` fields say so.
- UI Kit excludes Muse for all kinds and carries the kit-curator gate note.

Prelude's product traffic (`model_config` behind `llm-proxy`) is out of scope, because that is the gateway side.

## API boundary

- `loadPolicy(path?)` synchronously reads, validates and deeply freezes policy.
  Its default path is relative to the module, independent of the working directory.
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
- `resolveCandidates(policy, kind, { repo, override, machine, failures })` returns
  `{ candidates, blocked }`. It lowercases `repo`, strips `.git`, and rejects invalid
  `owner/name` values. Candidate fields are:
  `{ route, type, provider, model, reasoning, machines, pool, vendor, tier, source,
  fallback, escalated, reason, instruction?, requiresSpendApproval?, note? }`.
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
classifier result, time, decision ID, alternation history and limits arrive through
`deps`. The CLI reads them and logs the result. The worker adapter owns quota
normalization and spawn argument construction. `--execute` enables only Jev
classification; dispatch stays with the caller.

| Decision | Rule |
| --- | --- |
| Kind | `--kind` wins. Otherwise one Jev Choice over `kindsForClassifier` plus `unknown`, with state `{ brief }`. The request shape follows the [TypeSafe Choice contract](https://docs.typesafe.ai/primitives/choice). |
| Uncertainty | Unknown, malformed or unavailable answers return `needs_kind`. Retain up to three real kinds with valid probabilities; never invent probabilities for malformed responses. `confidence` retains Jev's confidence; thresholds use option probabilities. |
| Budget | Call `assertJevBudget` before credentials and request. Default cap is $0.01. Log measured input cost; use null when response usage is unavailable. Oversized requests are rejected, never truncated. |
| Machine | Explicit flag, then a sole allowed repo machine, then `mac-studio`. Conflicts block. |
| Cooldown | Skip limited routes, then use the surviving policy candidates. `limit` defaults to the route's policy duration, otherwise five hours. |
| Hard quota rules | Above 70% Claude session usage or 85% Codex weekly usage excludes that pool for tier 2. Both limits together block. Above 80% Claude session usage reserves Claude for tier 3 or main threads. The tier-2 preference still applies to main threads. |
| Pace | `elapsedPct = 100 * (now - (resetsAt - length)) / length`; headroom is elapsed minus used. Weekly length is seven days; session length is five hours. Compare full precision, show both headrooms. |
| Tie | `tieBreak.marginPoints: 5`, validated from 0 to 100. A difference at or below the margin alternates Sonnet/Astra, starting with Sonnet. Missing weekly data also causes a labelled trial. PC uses the same rule. |
| Missing quota | Failed reads or invalid/expired windows are unknown, never treated as zero usage. A remaining valid pool can still impose its stop. |
| Review | Exclude the author's entire vendor. If every candidate is excluded, try the nearest different-vendor route with the same machine, exclusion, cooldown and quota checks. |
| External | Return the instruction and spend-approval flag, with no spawn arguments. Worker cards cannot bypass an external instruction. |

`cards.byKind` values are package-relative `tasks/runs/<task-id>.card.json` paths.
The shipped package has no measured cards; absent files are reported in `why`.
The mapping is quick-edit → quick-edit, both bug-fix kinds → bug-fix, bounded-build
and multi-step-coding → implementation, and all review kinds → review.

Each worker route can declare unique `cardModels` aliases. These match the exact
model IDs in task cards, including `meta/muse-spark-1.3`,
`anthropic/claude-sonnet-5.5`, `anthropic/claude-opus-5.5` and the existing task slug
`openai/gpt-6-luna` for the Luna route. Aliases are explicit policy mappings;
changing a route model needs review of its aliases and existing measurements.
DeepSeek has no worker route and therefore cannot select one.

A card can choose an allowed route, including a resolved fallback, only when
`CALIBRATED` and strictly younger than `cards.maxAgeDays`. Future dates, stale
cards, `UNCALIBRATED`, `SINGLE_CANDIDATE` and disallowed winners are ignored with a
reason. A fresh `NO_CLEAR_WINNER` may choose `card-cheaper` only within a pace tie,
when both candidates have measured, comparable cost per accepted result and the
recommended one costs less. Null subscription costs cannot break a tie.

Pi is available only on Mac Studio and is the emergency local choice only for
`bulk-text`. `pick` returns a plan and notes that the local server must be started
and checked before dispatch. It does not run the liveness command or add network
probes to a dry pick. Image work names Codex image tooling; `pi-imagen` is a tool
note, not an additional worker route.

## State

The decision log is also the alternation record: only logged `ok` decisions with
`basis: trial` advance that kind. A directory lock serializes pick/log and limit
updates; no lock is held during classification. Limits are atomically replaced in
`limits.json`. A killed process can leave `.lock`; check that no pick or limit
process is running before removing it. No automatic stale-lock removal can race
an active writer.

State is under `MODEL_ROUTING_STATE_DIR`, otherwise
`$XDG_STATE_HOME/model-routing`, otherwise `~/.local/state/model-routing`.
The brief is logged as `{ sha256, length }`, where length is JavaScript string
length (UTF-16 code units). Request/response bodies and credentials are never
logged. Policy and card explanations remain in `why`; repo notes remain in
`notes`; resolver exclusions remain in `alternatives`.
