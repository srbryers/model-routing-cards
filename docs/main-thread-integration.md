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
count of failed attempts at the current tier (at 2, the task moves up one
tier), `--author ROUTE_OR_VENDOR` for reviews (the reviewer must be a
different vendor), `--main-thread` when the main thread itself needs a route
from the reserved pool, and `--machine M` to pin a machine (`mac-studio` or
`pc`). `--cards-dir DIR` points `pick` at a directory of routing cards (see
below).
`--execute` allows classification of the brief; with `--kind` no model is
called. Without `--execute`, a bare brief returns `needs_kind` and reads no
credentials. Quota is read locally. `--require-quota` makes `pick` return
`blocked` when quota cannot be read, instead of skipping the hard stops; do
not combine it with `--no-quota`, which skips the quota read.

Act on `status` in the output:

| `status` | Meaning | What to do |
|---|---|---|
| `ok` | A route was chosen | Run `spawn.argv`, filling in anything in `spawn.missing` first |
| `needs_kind` | The kind is unknown | Take one from `classifier.top`, or judge it, and re-run with `--kind` |
| `external` | Follow `instruction` instead of spawning | If `requiresSpendApproval` is true, get approval first |
| `blocked` | No allowed route | Report back and quote `why` |

Exit codes: 0 for `ok` or `external`, 3 for `needs_kind`, 4 for
`blocked`, 2 for bad input. Every decision is logged with an id, its
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

## Policy

`policy/policy.json` holds the routes, tiers, kinds, quota thresholds and
repo rules. A repo can add a `.model-routing.json` override at its root;
the repo's own `AGENTS.md` or `CLAUDE.md` still wins where it routes work
differently. See [policy details](../policy/README.md).
