# CI and delivery

How we check and ship model-routing-cards. No Actions workflows are checked
in. Local checks below run manually; external GitGuardian checks also run.
Other automation and access configuration remain unresolved.

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
their own: GitGuardian succeeded on the prior reviewed head.

## No checked-in workflows, so manual checks

This repo has no `.github` directory and no checked-in workflow files.

- No push or PR Actions trigger is defined in this checkout. External
  GitGuardian success has been observed; workflow absence does not prove
  absence of other automation.
- Run the checks for the affected change type on your own machine.
- A missing log is a missing check. Do not claim a check you did not run.

## Checks by change type

Prereq for all rows: Node 20.12 or later (`node --version`).

| You changed | Run this | Boundary |
|---|---|---|
| Docs or Markdown only | Read the file back; check every relative link opens; `git diff --check` is clean | Touch no code or policy |
| Any `.mjs` file | The test file beside your change while working; full `npm test` (`node --test scripts/*.test.mjs bin/*.test.mjs`) before merge is recommended | Approve operations that can incur spend; see the command distinctions below |
| `policy/policy.json` | Affected tests plus `node bin/model-routing.mjs policy show` | Keep kind IDs stable; update `updated` |
| Task files under `tasks/` | The focused test file first, then the full suite if you touched runner code | Bake-off model calls need the README's explicit approval; dry previews do not |
| `references/`, `skills/` | Readback and link check | Keep meaning in sync with code |

Separate the operations (sources: `bin/model-routing.mjs`, `scripts/route.mjs`,
and README Pick, Record, and task setup):

- `run <task> --execute` executes a bake-off and calls the task's models.
  The README requires explicit approval before this step. Without
  `--execute`, it is a dry preview, with no credential read or request.
- `pick --kind` calls no model, even with `--execute`; that flag alone
  therefore needs no spend approval. Brief classification without an
  explicit kind stays dry without `--execute`. Executing that classification
  calls Jev and needs approval for that spend. Pick never dispatches.
- `record` is local by default. Its optional Jev judgement requires
  `--brief-file F --result-file R --execute` and approval for the Jev spend.
- The Jev per-call cap defaults to **$0.01** and is adjustable
  (`--jev-limit-usd N`); a cap is separate from approval.
- `pick --spend-approved ROUTE` authorizes a named metered worker route,
  not a bake-off. It is route-bound and only makes a spawn plan runnable.
  Later worker dispatch is separate and must stay within that approval.

Never pass `--force`, `--spend-approved`, or `--execute` to hide a failure.

## Focused vs full runs

- Focused: run the one test file beside your change, for example
  `node --test scripts/policy.test.mjs`. Use it while you work.
- Before merge: the full `npm test` is recommended, not required by any
  maintained gate. Base evidence has six failures by count only (see below).
  A docs PR does not have to fix them, and no one may claim full green.
- Never narrow a run to make it pass. Report what ran and what failed.

## Triggers, runners, secrets: no checked-in workflows

No Actions triggers, runners, caches, concurrency rules, or permission
settings are defined by checked-in workflows. Separately, GitHub API reads
on 2026-10-09 returned zero Actions secrets, zero Actions variables, and
zero environments; the protection API reported `main` unprotected.
Those reads do not establish app, deploy-key, provider, or machine access
facts, which remain unresolved. If a workflow appears, record its settings
here.

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

No deploy or publish automation is configured in this checkout. External
release automation remains unresolved. Source review and release
are separate steps:

1. Commit on a feature branch and open one PR against `main`. Paste the
   test output that ran in the body.
2. After merge, a release is an authorized tag: the maintainer tags, and
   users install from it, for example
   `npm i -g github:srbryers/model-routing-cards#v0.2.1`.
3. This guide ships no release. Tag `v0.2.1` peels to base
   `289941cd97ec1f43ab7bddb0f357b6a0dcba6532`, verified with
   `git rev-parse 'v0.2.1^{}'`. Merging cannot deliver new work through that tag, and a version
   bump alone creates no tag.
4. Verify the source revision: `git log -1 --format=%H` on the merge.
   The installed package is not a source checkout: `package.json`
   `files` excludes `CI/`, all test files, and `tasks/runs`, so
   installing plus `npm test` is not the consumer check. Record the authorized
   tag and its peeled target separately from the source SHA. Consumer
   revision verification is **unresolved**: no maintained installed-artifact
   check is documented (owner: srbryers, with the installing consumer).
   An install command alone does not prove which revision was received.

## Rollback

No rollback doc exists. The current fallback is to reinstall the prior tag,
for example `npm i -g github:srbryers/model-routing-cards#v0.2.0`. If delivery
ever gains real deploys, write the rollback steps here first. The example
is an install request, not a verified recovery receipt; consumer revision
verification remains unresolved with srbryers and the installing consumer.

## Rerun reasons

- Rerun affected tests after each code change.
- `node scripts/route.mjs run <task> --force` is a dry preview. It exits
  before receipt replacement: no credential is read and nothing is sent.
- To replace stale receipts, first preserve the old receipts, then use
  `node scripts/route.mjs run <task> --force --execute` only with the
  README's explicit bake-off approval. Execution without `--force` skips
  existing receipts. Preserve the replacement receipts and the reason for
  the rerun; the runner overwrites files rather than retaining versions.
- A rerun that turns red is news, not noise. Never skip a failing test or
  drop a gate to hide a defect. Record field results with
  `model-routing record` instead.

## Cleanup, ports, identity

- Ports: none. This is a CLI, not a server. Nothing listens.
- Source identity: `git log -1 --format=%H` on the merge. An authorized
  tag and its peeled target identify the intended install source. They do
  not verify the installed artifact. Consumer revision verification remains
  unresolved (owner: srbryers with the installing consumer).
- Decisions log to `$XDG_STATE_HOME/model-routing/decisions.jsonl`
  (override with `MODEL_ROUTING_STATE_DIR`). The brief is stored as a SHA-256
  hash plus length only.
- Receipts sit beside the task file under `<task-dir>/runs/<task-id>/`;
  `route.mjs` creates that dir even on a dry run. Those receipts are your
  output: preserve old/new rerun receipts for review; clean only outputs
  owned by your run. Published cards go to
  `$XDG_DATA_HOME/model-routing/cards`. No routing state is written into a
  task repo.

## Remaining gates before you call it done

1. Retained author evidence: event 186 reports **390 passed, 6 failed,
   396 total**. Event 201 names six docs-working-tree record/outcomes/
   log-helper failures. Event 207 records stash-u at base
   `289941cd97ec1f43ab7bddb0f357b6a0dcba6532`, filtered **390 passed /
   6 failed**, then stash pop. This supports matching counts only, not
   identical individual base failures or a full clean-base transcript.
   No full-green claim; these tests were not rerun for this repair.
2. `git diff --check` is clean and every new link resolves.
3. Approve the operation that can incur spend: bake-off execution, Jev
   classification/judgement, or later metered worker dispatch. Explicit-kind
   pick calls no model. Pick's `--spend-approved ROUTE` is route-bound worker
   authorization, not a bake-off switch; a new paid route needs approval.
   Consumer revision verification remains unresolved with srbryers and
   the installing consumer.
4. A human reviewed the diff. The maintainer merges; nothing auto-merges.

## More

- [Policy details](../policy/README.md)
- [Task interface](../references/task-interface.md)
- [Routing from a main thread](../docs/main-thread-integration.md)
- [Skill notes](../SKILL.md)
