# Routing policy

Choose the cheapest capable tier, then the provider with the most quota headroom.
`policy.json` is version 1 of that policy. The task brief supersedes the older
`routing-profile.md` draft; benchmark evidence does not change policy by itself.

| Section | Meaning |
| --- | --- |
| `routes` | BB provider/model IDs, vendor, pool, allowed machines and reasoning caps. Pi's liveness command is data; loading never runs it. |
| `pools` | Shared subscription pools, readable quota windows and provider restrictions. |
| `tiers` | Ordered routes, fallbacks and default reasoning for each paid tier. |
| `kinds` | Fixed classifier labels, descriptions, tier, reasoning and explicit route order. `local` and `image` are outside paid tiers. `null` reasoning means no effort setting. |
| `escalation` | Two failures at the current tier advance one tier: 1 → 2 at high, 2 → 3 at xhigh. Tier 3, local and image have no escalation step. |
| `quota` | Strict **greater-than** used-percent thresholds, five-hour Muse cooldown and emergency fallback. Hard stops beat overrides. |
| `tieBreak` | Tier 2: repo rule, machine eligibility, weekly pace, then alternate Sonnet/Astra and label the choice `trial`. PC allows either. |
| `review` | Review kinds require a different vendor from the author. |
| `cards` | Only fresh `CALIBRATED` winners may replace a candidate. Validation checks the 30-day literal against `TRUST.STALE_DAYS`. |
| `machines` | Available machine IDs and their descriptions. |
| `repos` | Repo rules keyed by lowercase GitHub `owner/name`; each has `rules` and optional `machines`. |

## Change the policy

1. Edit the JSON and update `updated`. Keep kind IDs stable; each description is
   read by the classifier. Keep kind candidate lists and tier defaults consistent.
2. Keep route references valid. Muse is Mac-only, contributor models are forbidden,
   Claude's pool requires Claude Code, and Sonnet is capped at high.
3. Run `npm test`. The loader rejects unsupported versions, unknown fields and
   invalid references. A format change needs a new supported `policyVersion`.

## Repo overrides

The three real repo rules live here in `policy.json`, under `repos`. No files need
to be added to those repos. For an optional local override, put
`.model-routing.json` at the repo root (`examples/` has one generic sample):

```json
{
  "policyVersion": 1,
  "machines": ["pc"],
  "rules": [
    {
      "kinds": ["3d-work"],
      "route": "astra",
      "reasoning": "high",
      "source": "CLAUDE.md",
      "why": "All 3D work goes to Astra."
    }
  ]
}
```

`machines` and each rule's `reasoning` are optional. `rules` may be empty.
Machine precedence is file → central repo entry → all policy machines. A supplied
list replaces the inherited list and restricts every candidate. Each kind may
appear in only one rule within each source. Source paths are provenance
text, never read. An override route must run on at least one allowed repo machine.

For each kind, order is **repo file → `repos[owner/name]` → tier rules**. A file
rule wins over a central rule for that kind; unmatched kinds keep central rules.
An empty file does not erase central rules. Lower-priority routes remain as
fallbacks. Repo rules also outrank escalation. Reasoning defaults to the kind's
effort (or escalated effort), capped by the route; explicit effort above a cap is
an error. Machine limits and Muse's skill-workflow exclusion still apply.

⚠ A repo preference cannot create quota. PR 3 must report an override blocked by
quota, try eligible fallbacks, then stop and report if none remain. Conflicting
thresholds must never bounce between exhausted pools. Likewise, a review override
cannot bypass the different-vendor rule; stop if no eligible reviewer remains.

The central entries encode the supplied rules without reading other repos:

- Wedding uses Astra for `data-contract` and **all** `high-risk-review`. The fixed
  labels cannot isolate data-contract reviews, so this deliberately broadens that
  repo rule. No kind was added.
- Fathoms Game restricts all candidates to PC and uses Astra for its four listed
  review/reasoning kinds.
- Flora Studio uses Astra for `3d-work` and Luna for both ordinary review kinds.
  Classify 3D review as `3d-work` to preserve its all-3D rule.

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
  propagate. Pass the key to the resolver; it does not detect repos itself.
- `resolveCandidates(policy, kind, { repo, override, machine, failures })` returns ordered
  unique routes with provider, model, reasoning, eligible `machines`, pool, vendor
  and a reason. Omitting machine leaves all eligible machines; a conflicting repo
  machine restriction yields `[]`. Invalid inputs throw. Inputs are never mutated.

⚠ These are **candidates**, not dispatch decisions. PR 3 must check quota, liveness,
review vendor and card trust, apply weekly pace and maintain alternation state.
A fallback is usable only after earlier candidates are unavailable. Muse cooldown
makes Luna eligible; Pi must pass its liveness check. Only `bulk-text` is declared
suitable for emergency local fallback. Its normal paid fallback uses medium effort.
Image work names Codex image tooling; `pi-imagen` is a tool note, not a seventh route.
