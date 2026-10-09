# CI and delivery

How we check and ship model-routing-cards. There is no automated CI here,
so every step below is manual. If you add a workflow later, update this file.

Base: `289941cd97ec1f43ab7bddb0f357b6a0dcba6532` (2026-10-04, `origin/main`).
Template pin: `e938d054825d4b20b7d3fb63a4629e97b97a4142` (ci repo
`templates/CI-CD.md`, 2026-10-09, verified via API) supplies optional
prompts only (`ci#1` still unmerged). Adapted, not copied.

## Owners

| Thing | Owner |
|---|---|
| Repo and release calls | srbryers (sole maintainer) |
| Routing policy (`policy/policy.json`) | srbryers; see [policy details](../policy/README.md) |
| Personal overrides (`policy.local.json`, `.model-routing.json`) | you, on your own machine only |
| Check results | the person who ran them; paste the output in the PR |

Content checks belong to the author. External app checks still run on
their own: GitGuardian succeeded on this head.

## No checked-in workflows, so manual checks

This repo has no `.github` directory and no workflow files. That means:

- No Actions run on push or on a PR. A green badge never exists.
- You run every check below on your own machine before you ask for review.
- A missing log is a missing check. Do not claim a check you did not run.

## Checks by change type

Prereq for all rows: Node 20.12 or later (`node --version`).

| You changed | Run this | Boundary |
|---|---|---|
| Docs or Markdown only | Read the file back; check every relative link opens; `git diff --check` is clean | Touch no code or policy |
| Any `.mjs` file | The test file beside your change while working; full `npm test` (`node --test scripts/*.test.mjs bin/*.test.mjs`) before merge is recommended | No `--execute` without explicit spend approval |
| `policy/policy.json` | Affected tests plus `node bin/model-routing.mjs policy show` | Keep kind IDs stable; update `updated` |
| Task files under `tasks/` | The focused test file first, then the full suite if you touched runner code | Dry runs only until spend is approved |
| `references/`, `skills/` | Readback and link check | Keep meaning in sync with code |

Separate the spend steps. `pick --kind` calls no model at all, even with
`--execute`. Without `--execute`, brief classification stays dry: nothing is
sent and no key is read. With `--execute`, `pick` authorizes classification
only, never dispatch: it prints a spawn plan for a human or agent to run.
Optional `record` judgement calls go through Jev. The Jev per-call cap
defaults to **$0.01** and is adjustable (`--jev-limit-usd N`).
`--spend-approved ROUTE` names a metered route the run may bill; that
authorization is route-bound, and it still does not launch anything.
Never pass `--force`, `--spend-approved`, or `--execute` to hide a failure.

## Focused vs full runs

- Focused: run the one test file beside your change, for example
  `node --test scripts/policy.test.mjs`. Use it while you work.
- Before merge: the full `npm test` is recommended, not required by any
  maintained gate. Six failures are known on base (see below); a docs PR
  does not have to fix them, and no one may claim full green.
- Never narrow a run to make it pass. Report what ran and what failed.

## Triggers, runners, secrets: no checked-in workflows

No Actions triggers, runners, cache, concurrency rules, permissions,
GitHub secrets, or protected environments exist, because no workflow
exists. Verified live 2026-10-09: `main` has no branch protection, and
the repo has no Actions secrets and no environments. That covers GitHub
settings only, not provider or machine access. If a workflow appears,
record its settings here.

Secret names the code itself reads (local use only, never commit them):

- `TYPESAFE_API_KEY`, `TYPESAFE_ENV_FILE` — Jev judgement calls only.
- `OPENROUTER_API_KEY`, `SUBCONSCIOUS_API_KEY` — metered provider routes,
  read by `route.mjs`/`providers.mjs`.
- `CODEX_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME` — login
  and state locations for subscription CLIs and local logs.
- `MODEL_ROUTING_STATE_DIR`, `MODEL_ROUTING_CARDS_DIR`,
  `MODEL_ROUTING_ALLOW_MUSE_MCP` — local overrides.
- Subscription routes (Codex, Claude, Pi) use each CLI's own login. There is
  no repo API key. `record --notes` (max 500 chars) must never hold secrets.

## Delivery: manual, from your checkout

There is no auto deploy and no publish config. Source review and release
are separate steps:

1. Commit on a feature branch and open one PR against `main`. Paste the
   test output that ran in the body.
2. After merge, a release is an authorized tag: the maintainer tags, and
   users install from it, for example
   `npm i -g github:srbryers/model-routing-cards#v0.2.1`.
3. This guide ships no release. Note `v0.2.1` points at base `289941c`,
   so merging cannot deliver new work through that tag, and a version
   bump alone creates no tag.
4. Verify the source revision: `git log -1 --format=%H` on the merge.
   The installed package is not a source checkout: `package.json`
   `files` excludes `CI/`, all test files, and `tasks/runs`, so
   installing plus `npm test` is not the consumer check. State the
   authorized tag and the consumer revision check separately.

## Rollback

No rollback doc exists. The current fallback is to reinstall the prior tag,
for example `npm i -g github:srbryers/model-routing-cards#v0.2.0`. If delivery
ever gains real deploys, write the rollback steps here first.

## Rerun reasons

- Rerun affected tests after each code change.
- Rerun `node scripts/route.mjs run <task> --force` only to replace stale
  receipts; a plain `run` skips recorded work by design. `--force` without
  `--execute` stays dry: no credential is read and nothing is sent.
- A rerun that turns red is news, not noise. Never skip a failing test or
  drop a gate to hide a defect. Record field results with
  `model-routing record` instead.

## Cleanup, ports, identity

- Ports: none. This is a CLI, not a server. Nothing listens.
- Source identity: `git log -1 --format=%H` on the merge. Install identity
  is the authorized tag. They are separate claims; never swap one for
  the other.
- Decisions log to `$XDG_STATE_HOME/model-routing/decisions.jsonl`
  (override with `MODEL_ROUTING_STATE_DIR`). The brief is stored as a SHA-256
  hash plus length only.
- Receipts sit beside the task file under `<task-dir>/runs/<task-id>/`;
  `route.mjs` creates that dir even on a dry run. Those receipts are your
  output: record them or clean them up. Published cards go to
  `$XDG_DATA_HOME/model-routing/cards`. No routing state is written into a
  task repo.

## Remaining gates before you call it done

1. Known failures: on base `289941cd97ec1f43ab7bddb0f357b6a0dcba6532`
  the suite reports matching counts of 390 passed and 6 failed out of 396
  (record/outcomes/log-helper tests). That is counts only, not proof of
  identical individual failures. No full-green claim.
2. `git diff --check` is clean and every new link resolves.
3. Spend approval stands for each `--execute` or metered route used
  (`needs_approval` is route-bound; a new route needs a new approval).
4. A human reviewed the diff. The maintainer merges; nothing auto-merges.

## More

- [Policy details](../policy/README.md)
- [Task interface](../references/task-interface.md)
- [Routing from a main thread](../docs/main-thread-integration.md)
- [Skill notes](../SKILL.md)
