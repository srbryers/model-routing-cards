# Routing work from a main thread

An orchestrating agent hands every task to `model-routing pick`. `pick`
chooses the provider, model, reasoning level and machine, and prints the
exact spawn command. It never spawns the worker itself.

## Pick

Write the brief to a file first, then run:

```sh
model-routing pick --brief-file F --repo DIR --project ID --section ID \
  --title T --prompt-file F --execute --json
```

Useful extras: `--kind K` when the kind is known, `--failures N` after a
worker fails the same task twice (the task moves up one tier), `--author
ROUTE_OR_VENDOR` for reviews (the reviewer must be a different vendor),
`--main-thread` when the main thread itself needs a route from the reserved
pool, and `--machine M` to pin a machine (`mac-studio` or `pc`).
`--execute` allows classification of the brief; with `--kind` no model is
called. Without `--execute`, a bare brief returns `needs_kind` and reads no
credentials. Quota is read locally; `--no-quota` skips it.

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
rejected routes under `alternatives`.

## Worked example

Input:

```sh
model-routing pick --brief-file /tmp/rename.md --kind quick-edit --repo . \
  --project <project-id> --section <section-id> --title "Rename UserButton" \
  --prompt-file /tmp/rename.md --execute --json
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

## Policy

`policy/policy.json` holds the routes, tiers, kinds, quota thresholds and
repo rules. A repo can add a `.model-routing.json` override at its root;
the repo's own `AGENTS.md` or `CLAUDE.md` still wins where it routes work
differently. See [policy details](../policy/README.md).
