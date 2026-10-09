# CI and delivery

How we check and ship model-routing-cards. There is no automated CI here,
so every step below is manual. If you add a workflow later, update this file.

Base: `289941cd97ec1f43ab7bddb0f357b6a0dcba6532` (2026-10-04, `origin/main`).
Template pin: `e938d054825d4b20b7d3fb63a4629e97b97a4142` (ci repo
`templates/CI-CD.md`, 2026-10-09, verified via API). Adapted, not copied.

## Owners

| Thing | Owner |
|---|---|
| Repo and release calls | srbryers (sole maintainer) |
| Routing policy (`policy/policy.json`) | srbryers; see [policy details](../policy/README.md) |
| Personal overrides (`policy.local.json`, `.model-routing.json`) | you, on your own machine only |
| Check results | the person who ran them; paste the output in the PR |

No check owner beyond the author: nothing runs on its own.

## No workflows, so manual checks

This repo has no `.github` directory and no workflow files. That means:

- Nothing runs on push or on a PR. A green badge never exists.
- You run every check below on your own machine before you ask for review.
- A missing log is a missing check. Do not claim a check you did not run.

## Checks by change type

Prereq for all rows: Node 20.12 or later (`node --version`).

| You changed | Run this | Boundary |
|---|---|---|
| Docs or Markdown only | Read the file back; check every relative link opens; `git diff --check` is clean | Touch no code or policy |
| Any `.mjs` file | `npm test` (runs `node --test scripts/*.test.mjs bin/*.test.mjs`) | No `--execute` without explicit spend approval |
| `policy/policy.json` | `npm test` plus `node bin/model-routing.mjs policy show` | Keep kind IDs stable; update `updated` |
| Task files under `tasks/` | The focused test file first, then `npm test` | Dry runs only until spend is approved |
| `references/`, `skills/` | Readback and link check | Keep meaning in sync with code |

Boundaries that always hold: without `--execute` nothing is sent and no key
is read. With `--execute` you spend real money through provider CLIs. The
per-call Jev cap is **$0.01** (`--jev-limit-usd`). Never pass `--force`,
`--spend-approved`, or `--execute` to hide a failure.

## Focused vs full runs

- Focused: run the one test file beside your change, for example
  `node --test scripts/policy.test.mjs`. Use it while you work.
- Stable candidate: run the full `npm test` once at the end. A PR needs this.
- Focused green plus full red means the PR is not ready. Fix it, do not
  narrow the run to make it pass.

## Triggers, runners, secrets: none configured

No triggers, runners, cache, concurrency rules, permissions, GitHub secrets,
or protected environments exist, because no workflow exists. Verified live
2026-10-09: `main` has no branch protection, and the repo has no Actions
secrets and no environments. If a workflow appears, record its settings here.

Secret names the code itself reads (local use only, never commit them):

- `TYPESAFE_API_KEY`, `TYPESAFE_ENV_FILE` — Jev judgement calls only.
- `CODEX_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME` — login
  and state locations for subscription CLIs and local logs.
- `MODEL_ROUTING_STATE_DIR`, `MODEL_ROUTING_CARDS_DIR`,
  `MODEL_ROUTING_ALLOW_MUSE_MCP` — local overrides.
- Subscription routes (Codex, Claude, Pi) use each CLI's own login. There is
  no repo API key. `record --notes` (max 500 chars) must never hold secrets.

## Delivery: manual, from your checkout

There is no auto deploy and no publish config. To ship:

1. Bump `version` in `package.json` and commit on a feature branch.
2. Open one PR against `main`. Paste the full `npm test` output in the body.
3. After merge, users install from git, for example
   `npm i -g github:srbryers/model-routing-cards#v0.2.1`.
4. Verify the revision: `git log -1 --format=%H`, `node --version`, and a
   fresh `npm test` from a clean checkout.

The journey is short on purpose: commit, review, merge, install from the tag.
There is no staging site and no artifact store.

## Rollback

No rollback doc exists. The current fallback is to reinstall the prior tag,
for example `npm i -g github:srbryers/model-routing-cards#v0.2.0`. If delivery
ever gains real deploys, write the rollback steps here first.

## Rerun reasons

- Rerun `npm test` after every code change, however small.
- Rerun `node scripts/route.mjs run <task> --force` only to replace stale
  receipts; a plain `run` skips recorded work by design.
- A rerun that turns red is news, not noise. Never skip a failing test or
  drop a gate to hide a defect. Record field results with
  `model-routing record` instead.

## Cleanup, ports, identity

- Ports: none. This is a CLI, not a server. Nothing listens.
- Identity: decisions log to `$XDG_STATE_HOME/model-routing/decisions.jsonl`
  (override with `MODEL_ROUTING_STATE_DIR`). The brief is stored as a SHA-256
  hash plus length only.
- Receipts sit beside the task file; published cards go to
  `$XDG_DATA_HOME/model-routing/cards`. No routing state is written into a
  task repo. State lives outside this repo, so there is nothing to clean here.

## Remaining gates before you call it done

1. Full `npm test` is green on a clean checkout. Note: on base
  `289941c` 6 of 396 tests fail (record/outcomes/log-helper tests);
  pre-existing, so fix them before you call any candidate stable.
2. `git diff --check` is clean and every new link resolves.
3. Spend approval stands for each `--execute` or metered route used
  (`needs_approval` is route-bound; a new route needs a new approval).
4. A human reviewed the diff. The maintainer merges; nothing auto-merges.

## More

- [Policy details](../policy/README.md)
- [Task interface](../references/task-interface.md)
- [Routing from a main thread](../docs/main-thread-integration.md)
- [Skill notes](../SKILL.md)
