# Routing work from a main thread

An orchestrating agent hands every task to `model-routing pick`. `pick`
chooses the provider, model, reasoning level and machine, and prints the
exact spawn command. It never spawns the worker itself.

## Pick

Write the brief to a file first, then run:

```sh
model-routing pick --brief-file F --repo DIR --project ID --section ID \
  --title T --prompt-file F --execute --require-quota --json
```

Useful extras: `--kind K` when the kind is known, `--failures N` with the
total number of failed attempts on the task, across tiers (every 2 failures
move the task up one tier, up to tier 3; a tier-1 task that failed 4 times
goes to tier 3), `--author ROUTE_OR_VENDOR` for reviews (the reviewer must
be a different vendor), `--main-thread` when the main thread itself needs a route
from the reserved pool, and `--machine M` to pin a machine (`mac-studio` or
`pc`). `--cards-dir DIR` points `pick` at a directory of routing cards (see
below).
`--execute` allows classification of the brief; with `--kind` no model is
called. Without `--execute`, a bare brief returns `needs_kind` and reads no
credentials. Quota is read locally. `--require-quota` makes `pick` return
`blocked` when quota is unknown for a readable pool (Claude, Codex),
instead of skipping the hard stops; do not combine it with `--no-quota`,
which skips the quota read. Muse and local Pi have no readable quota by
design. They never block on `--require-quota`; their limits come from
`model-routing limit` cooldowns.

Act on `status` in the output:

| `status` | Meaning | What to do |
|---|---|---|
| `ok` | A route was chosen | Fill in `spawn.missing`, do every step in `beforeSpawn`, apply `notes`, then run `spawn.argv` (see below) |
| `needs_kind` | The kind is unknown | Take one from `classifier.top`, or judge it, and re-run with `--kind` |
| `external` | Follow `instruction` instead of spawning | If `requiresSpendApproval` is true, get approval first |
| `blocked` | No allowed route | Report back and quote `why` |

## Before dispatch

`ok` means the route is chosen, not that it is ready. Before running
`spawn.argv`:

1. Fill in anything listed in `spawn.missing`.
2. Do every step in the `beforeSpawn` list. Example: for `pi-local`, check
   the local server with `curl -s -m 3 127.0.0.1:8080/v1/models`.
3. Read `notes` and apply any that set conditions.
4. Then run `spawn.argv`.

Routes with no reasoning setting (Pi) have no `--reasoning-level` flag.
That is not "missing".

Exit codes: 0 for `ok` or `external`, 3 for `needs_kind`, 4 for
`blocked`, 2 for bad input. Exits 3 and 4 are answers, not errors: never
fall back to manual routing on them. Every decision is logged with an id, its
`basis` (`policy`, `trial`, `card` or `card-cheaper`), `why`, and the
rejected routes under `alternatives`. The log stores no brief text (only a
SHA-256 hash and length), no titles, and no spawn arguments; those print to
stdout only.

## Worked example

Input:

```sh
model-routing pick --brief-file /tmp/rename.md --kind quick-edit --repo . \
  --project <project-id> --section <section-id> --title "Rename UserButton" \
  --prompt-file /tmp/rename.md --execute --require-quota --json
```

Abridged output:

```json
{
  "status": "ok",
  "kind": "quick-edit",
  "route": "muse",
  "provider": "acp-muse",
  "model": "muse-spark-1.3",
  "reasoning": "medium",
  "machine": "mac-studio",
  "basis": "policy",
  "why": ["tier 1 for quick-edit", "policy kind quick-edit, tier 1"],
  "spawn": {
    "argv": ["bb", "thread", "spawn", "--project", "<project-id>",
             "--parent-self", "--section", "<section-id>",
             "--new-environment", "worktree", "--provider", "acp-muse",
             "--model", "muse-spark-1.3", "--reasoning-level", "medium",
             "--machine", "mac-studio", "--title", "Rename UserButton",
             "--prompt-file", "/tmp/rename.md"],
    "missing": []
  }
}
```

Follow-up: run the printed command as-is (`missing` is empty, so nothing
needs filling in):

```sh
bb thread spawn --project <project-id> --parent-self --section <section-id> \
  --new-environment worktree --provider acp-muse --model muse-spark-1.3 \
  --reasoning-level medium --machine mac-studio --title "Rename UserButton" \
  --prompt-file /tmp/rename.md
```

## Limit

When a worker reports a limit error for its route, mark that route
unavailable so later picks skip it, then re-pick:

```sh
model-routing limit <route> [--hours N]
```

The default cooldown comes from the policy (otherwise five hours).

## Record and outcomes

After verifying a child's work, record the result against the decision id
from the `pick` output:

```sh
model-routing record <decision-id> --result pass|fail|partial|abandoned --gate name=pass|fail ...
```

Use the gate results from the checks actually run. `model-routing
outcomes` shows pass and fail counts per kind, which is what future picks
and routing cards learn from.

## Cards

`pick` looks for a routing card for the task kind in this order:
`--cards-dir`, `MODEL_ROUTING_CARDS_DIR`, `<repo>/tasks/runs`, then
`$XDG_DATA_HOME/model-routing/cards`. Write a card with:

```sh
model-routing card <task.mjs> --out <dir>
```

A card only counts when it is `CALIBRATED` and fresh (under 30 days old),
and it never overrides a repo rule: a repo rule always wins over a card.
Exception: a fresh `NO_CLEAR_WINNER` card may choose the cheaper route
(`basis: card-cheaper`), but only inside a Sonnet/Astra pace tie, and only
when both routes have measured costs. Subscription routes have no measured
cost, so this rarely applies.

## Local Pi model

The policy no longer holds the local Pi model path. It goes in an untracked
`~/.config/model-routing/local.json`:

```json
{ "routes": { "pi-local": { "model": "..." } } }
```

Without it, `pi-local` is unavailable.

## Policy

`policy/policy.json` holds the routes, tiers, kinds, quota thresholds and
repo rules. A repo can add a `.model-routing.json` override at its root;
the repo's own `AGENTS.md` or `CLAUDE.md` still wins where it routes work
differently. See [policy details](../policy/README.md).
