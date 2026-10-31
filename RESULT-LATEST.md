# Latest Model Tags

The shared policy and Flora profile now select the provider’s latest aliases, `sonnet` and `opus`. **Live resolution succeeded for the bare aliases; the API rejects both `@latest` spellings with 404.** The coordinator tested all four forms on 2026-10-31. See [coordinator evidence](#coordinator-verification-2026-10-31).

This report and the work are committed on `bb/latest-model-tags` and opened as draft PR #25.

## Route Inventory

The table covers every shared-policy and Flora-profile route. The four converted picks use the latest aliases tested by the coordinator on the Claude Code subscription path. External instructions have no provider/model spawn fields. See [coordinator evidence](#coordinator-verification-2026-10-31).

| Route | Provider | Model Before | Model After / Pin Kept | Decision | Reason |
|---|---|---|---|---|---|
| shared `muse` | acp-muse | `muse-spark-1.3` | `muse-spark-1.3` | exception | Exception: local Muse model-profile resolves the exact ID. CLI help offers a catalogue model ID, not a latest alias. No latest form established on acp-muse. |
| shared `sonnet` | claude-code | `claude-sonnet-5-5` | `sonnet` | converted | Provider-accepted latest alias; coordinator observed successful subscription resolution on 2026-10-31. [Coordinator evidence](#coordinator-verification-2026-10-31) |
| shared `opus` | claude-code | `claude-opus-5-5` | `opus` | converted | Provider-accepted latest alias; coordinator observed successful subscription resolution on 2026-10-31. [Coordinator evidence](#coordinator-verification-2026-10-31) |
| shared `astra` | codex | `gpt-6-astra` | `gpt-6-astra` | exception | Exception: Codex 0.160.0 cached account catalogue lists this fixed ID, with no latest tag or alias offered. |
| shared `sol` | codex | `gpt-6.1-sol` | `gpt-6.1-sol` | exception | Exception: Codex 0.160.0 cached account catalogue lists this fixed ID, with no latest tag or alias offered. |
| shared `luna` | codex | `gpt-5.6-luna` | `gpt-5.6-luna` | exception | Exception: exact gpt-5.6-luna/openai/gpt-5.6-luna identity required by mismatch tests and stale-identity guard. |
| shared `pi-local` | pi | null / no model field | null / no model field | exception | Exception: null shared model; local configuration supplies identity. No standing shared pin to convert. |
| shared `gemini-copy` | external instruction | null / no model field | null / no model field | exception | Exception: spend-gated external drafting instruction, not a standing worker pick. Keep google/gemini-3.8-flash as a directed candidate. |
| shared `openai-image` | external instruction | null / no model field | null / no model field | exception | Exception: spend-gated external instruction; no model field or standing worker pick. |
| shared `gpt-5.5` | codex | `gpt-5.5` | `gpt-5.5` | exception | Exception: fixed Codex account path; absent from the current cached catalogue. No latest alias or successful replacement established. |
| shared `terra` | codex | `gpt-5.6-terra` | `gpt-5.6-terra` | exception | Exception: Codex catalogue lists gpt-5.6-terra and gpt-6.1-terra as separate fixed IDs. No latest alias offered; do not infer a version upgrade. |
| shared `fw-kimi-k3` | pi | `fireworks/accounts/fireworks/models/kimi-k3` | `fireworks/accounts/fireworks/models/kimi-k3` | exception | Exception: spend-gated Pi/Fireworks measurement candidate; exact identity is the candidate. No latest form established on this path; no paid probe. |
| shared `fw-glm-5p3` | pi | `fireworks/accounts/fireworks/models/glm-5p3` | `fireworks/accounts/fireworks/models/glm-5p3` | exception | Exception: spend-gated Pi/Fireworks measurement candidate; exact identity is the candidate. No latest form established on this path; no paid probe. |
| shared `fw-deepseek-v4p1-flash` | pi | `fireworks/accounts/fireworks/models/deepseek-v4p1-flash` | `fireworks/accounts/fireworks/models/deepseek-v4p1-flash` | exception | Exception: spend-gated Pi/Fireworks measurement candidate; exact identity is the candidate. No latest form established on this path; no paid probe. |
| shared `fw-minimax-m3` | pi | `fireworks/accounts/fireworks/models/minimax-m3` | `fireworks/accounts/fireworks/models/minimax-m3` | exception | Exception: spend-gated Pi/Fireworks measurement candidate; exact identity is the candidate. No latest form established on this path; no paid probe. |
| shared `fw-qwen3p8-max` | pi | `fireworks/accounts/fireworks/models/qwen3p8-max` | `fireworks/accounts/fireworks/models/qwen3p8-max` | exception | Exception: spend-gated Pi/Fireworks measurement candidate; exact identity is the candidate. No latest form established on this path; no paid probe. |
| shared `fw-gpt-oss-120b` | pi | `fireworks/accounts/fireworks/models/gpt-oss-120b` | `fireworks/accounts/fireworks/models/gpt-oss-120b` | exception | Exception: spend-gated Pi/Fireworks measurement candidate; exact identity is the candidate. No latest form established on this path; no paid probe. |
| shared `gemini-pro` | acp-gemini | `gemini-3.1-pro-preview` | `gemini-3.1-pro-preview` | exception | Exception: spend-gated ACP/Vertex candidate. Gemini help accepts a model string but establishes no latest alias; no paid probe. |
| shared `gemini-flash` | acp-gemini | `gemini-3.8-flash` | `gemini-3.8-flash` | exception | Exception: spend-gated ACP/Vertex candidate. Gemini help accepts a model string but establishes no latest alias; no paid probe. |
| shared `gemini-flash-lite` | acp-gemini | `gemini-3.5-flash-lite` | `gemini-3.5-flash-lite` | exception | Exception: spend-gated ACP/Vertex candidate. Gemini help accepts a model string but establishes no latest alias; no paid probe. |
| shared `or-gemini-flash` | pi | `openrouter/google/gemini-3.8-flash` | `openrouter/google/gemini-3.8-flash` | exception | Exception: spend-gated Pi/OpenRouter candidate, disabled for credit exhaustion. No latest form established; no paid probe. |
| shared `or-gemini-pro` | pi | `openrouter/google/gemini-3.1-pro-preview` | `openrouter/google/gemini-3.1-pro-preview` | exception | Exception: spend-gated Pi/OpenRouter candidate, disabled for credit exhaustion. No latest form established; no paid probe. |
| Flora `astra` | codex | `gpt-6-astra` | `gpt-6-astra` | exception | Exception: Codex 0.160.0 cached account catalogue lists this fixed ID, with no latest tag or alias offered. |
| Flora `opus` | claude-code | `claude-opus-5-5` | `opus` | converted | Provider-accepted latest alias; coordinator observed successful subscription resolution on 2026-10-31. [Coordinator evidence](#coordinator-verification-2026-10-31) |
| Flora `sonnet` | claude-code | `claude-sonnet-5-5` | `sonnet` | converted | Provider-accepted latest alias; coordinator observed successful subscription resolution on 2026-10-31. [Coordinator evidence](#coordinator-verification-2026-10-31) |
| Flora `sol` | codex | `gpt-6.1-sol` | `gpt-6.1-sol` | exception | Exception: Codex 0.160.0 cached account catalogue lists this fixed ID, with no latest tag or alias offered. |
| Flora `luna` | codex | `gpt-5.6-luna` | `gpt-5.6-luna` | exception | Exception: exact gpt-5.6-luna/openai/gpt-5.6-luna identity required by mismatch tests and stale-identity guard. |
| Flora `jev` | typesafe | `jev-latest` | `jev-latest` | exception | Exception (already latest): jev-latest needs no change. Family identity and semantic use remain blocked. |
| Flora `muse-wonder` | muse | `muse-wonder` | `muse-wonder` | exception | Exception: exact Muse platform seat identity required by scripts/flora.mjs, separate from generic Spark ACP route. |

## Offline Evidence

- `claude --version`: `2.1.296 (Claude Code)`.
- `claude --help`: `--model` accepts an alias for the latest model, with examples `fable`, `opus`, and `sonnet`. It does not document `@latest`.
- Read-only inspection of the installed Claude binary's strings found aliases `sonnet`, `opus`, `haiku`, `fable`, `best`, context-window variants, and `opusplan`. This is local implementation evidence, not proof that the service accepts `@latest`.
- `codex --version`: `codex-cli 0.160.0`. `codex --help` documents `--model <MODEL>` without a latest-tag syntax.
- The local account catalogue at `/Users/sebastianbryers/.codex/models_cache.json`, fetched October 31, 2026 at 09:00:12 UTC for client 0.160.0, offers fixed slugs. Relevant entries are `gpt-6-astra`, `gpt-6.1-sol`, `gpt-5.6-terra`, `gpt-6.1-terra`, and `gpt-5.6-luna`. It offers no latest aliases. `gpt-5.5` is absent. Absence does not prove that the service rejects every possible alias; none was established, so no alias was invented.
- `muse --help` and the installed binary's `model-profile --help` document a catalogue model ID, with `muse-spark-1.3` as the example. `/Users/sebastianbryers/.local/bin/muse-bin-1.4.4-R5419.1 model-profile show muse-spark-1.3` resolved that exact local profile with default reasoning effort `high`. No latest alias was established for ACP. The launcher also reported a sandbox-denied update-check timestamp write; the direct binary profile check was offline.
- `gemini --help` documents `--model` as a string. This does not prove a latest alias for ACP/Vertex. Gemini routes remain spend-gated candidates; Flora still forbids Gemini/Pi without direction and a new scoped profile.
- `pi --help` documents model patterns and IDs, including `provider/id`; pattern matching is not a provider latest alias. Offline Fireworks and Gemini model-list attempts returned no catalogue rows. Pi reported a sandbox-denied global settings lock during help. No global configuration was edited.
- No paid probes ran for Codex, Muse, Fireworks, Gemini, OpenRouter, or Jev. Spend flags, disabled fields, caps, reasoning, scope, fallback route lists, and authority were preserved.

## Claude Probes

### Coordinator Verification, 2026-10-31

The coordinator ran these clean probes outside the sandbox on the subscription path with Claude Code 2.1.296, `--output-format json`, and stdin closed. These results supersede the inconclusive round-1 observations below. Round 2 ran no live probes.

| Command | Result | Resolved Identity |
|---|---|---|
| `claude --model 'opus@latest' -p 'Reply with exactly: OK'` | `is_error: true`, `api_error_status: 404`; "There's an issue with the selected model (opus@latest). It may not exist or you may not have access to it." | None |
| `claude --model 'sonnet@latest' -p 'Reply with exactly: OK'` | `is_error: true`, `api_error_status: 404`; "There's an issue with the selected model (sonnet@latest). It may not exist or you may not have access to it." | None |
| `claude --model 'opus' -p 'Reply with exactly: OK'` | `result: OK`, `is_error: false` | `modelUsage: claude-opus-5-5`, `canonicalModel: claude-opus-5-5`, `provider: firstParty` |
| `claude --model 'sonnet' -p 'Reply with exactly: OK'` | `result: OK`, `is_error: false` | `modelUsage: claude-sonnet-5-5` |

The installed CLI help documents bare names as aliases for the latest model. Successful resolution establishes the accepted forms on this provider path; the 404 responses disprove the `@latest` spellings on that path.

### Round-1 Probe History

Exactly one invocation ran for each tag, on the requested subscription environment. No retry or alternate model probe ran. Shell tracing was not enabled. No token value was printed or written.

#### Opus

Exact command:

```sh
source ~/.zshrc >/dev/null 2>&1
export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_OAUTH_TOKEN"
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
claude --model 'opus@latest' -p 'Reply with exactly: OK'
```

Returned warning:

```text
"opus@latest" isn't described by this version's model catalog; update Claude Code, or map it with behavesAs on a modelPicker row (or modelOverrides, if it is a provider id of a model this version knows). Until then auto-compact keeps this session within 200k tokens (the context window it assumes); if the model accepts more, append [1m] to the model name for 1M, or set CLAUDE_CODE_MAX_CONTEXT_TOKENS to its real window; CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 restores the previous wait-for-the-API behavior.
[claude-code:unrecognized_model] {"model":"opus@latest","query_source":"sdk"}
```

No answer followed while the process was polled. After an interrupt request, the command result reported `Execution error` with exit code 0. No `OK` or resolved model identity was returned. This does not establish tag resolution.

#### Sonnet

Exact command:

```sh
source ~/.zshrc >/dev/null 2>&1
export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_OAUTH_TOKEN"
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
claude --model 'sonnet@latest' -p 'Reply with exactly: OK'
```

Returned warning:

```text
"sonnet@latest" isn't described by this version's model catalog; update Claude Code, or map it with behavesAs on a modelPicker row (or modelOverrides, if it is a provider id of a model this version knows). Until then auto-compact keeps this session within 200k tokens (the context window it assumes); if the model accepts more, append [1m] to the model name for 1M, or set CLAUDE_CODE_MAX_CONTEXT_TOKENS to its real window; CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 restores the previous wait-for-the-API behavior.
[claude-code:unrecognized_model] {"model":"sonnet@latest","query_source":"sdk"}
```

No answer followed while the process was polled. After an interrupt request, the command result reported `Execution error` with exit code 0. No `OK` or resolved model identity was returned. This does not establish tag resolution.

Neither invocation reported 429 or a rate-limit stop. No further Claude model call ran in round 1.

## Card Identities and Validators

`cardModels` entries stay exact. `scripts/cards.mjs` loads measured cards and quarantines stale Luna identities. `scripts/pick.mjs` matches `card.recommend` and measured rows against `cardModels`; `scripts/policy.mjs` validates those explicit unique aliases. Replacing them with CLI tags would break matching and relabel evidence.

Flora `cardIdentity` values stay exact for profile/live-policy matching and measured-row lookup. Task candidates in `tasks/_harness.mjs` are exact OpenRouter measurement identities, not Claude Code standing picks, so they retain their pins. Existing fixtures and `references/` retain their recorded identities.

The only production validator change is in `scripts/policy.mjs`: accept exactly `sonnet` and `opus` as latest aliases alongside existing `claude...` model IDs. Both `@latest` spellings are rejected. Alias detection also enforces the Claude provider, vendor, and pool in both directions. Arbitrary alias suffixes remain rejected.

`scripts/flora.mjs`, `validateFloraCards`, the stale-Luna guard, and the Muse Wonder seat pin were not edited. `node scripts/flora-cards.mjs` regenerated all 11 profile hash bindings from source; no hash was hand-edited. All static cards retain UNCALIBRATED trust and no measured rows.

The dated routing-decision example retains its earlier profile hash. Its test now checks rejection of the stale binding, then validates an in-memory copy bound to the current profile. The README explains this limit; no dated example or fixture was rewritten.

## Tests

Final full-suite command: `npm test`.

Final round-2 result: **420 tests passed, 0 failed, 0 skipped**, across 1 suite (417 top-level test entries). The Flora precheck accepted all 11 cards with zero provider calls.

| Test File | Added Or Updated Checks |
|---|---|
| `scripts/pick.test.mjs` | `standing Claude picks use latest aliases while measured card identities stay exact` checks actual Sonnet/Opus decisions and exact card aliases. |
| `bin/pick.test.mjs` | `CLI standing Claude picks emit latest model aliases in spawn data` checks both CLI picks. |
| `scripts/providers.test.mjs` | Tool-free argv test uses `sonnet`; `Claude latest aliases pass literally to the subscription CLI` covers both aliases with mocked subscription responses. |
| `scripts/flora.test.mjs` | `Flora Claude seats use latest aliases and preserve exact card identities` covers all four Claude roles. The dated example test rejects its stale binding and checks a current in-memory binding. |
| `scripts/policy.test.mjs` | Updated policy date; `Claude latest aliases preserve provider, pool and vendor restrictions` rejects typos, both `@latest` spellings, and provider/vendor/pool drift, including a Codex identity spoof. Standing shared-policy and Flora assertions fail if either pick returns to a pinned version or an `@latest` spelling. |

In round 1, the first full run found 4 failures: stale example binding, policy date assertion, and two incorrect new test expectations. Those test expectations were corrected; the dated file was preserved. A subsequent run passed 420 tests before the final validator hardening.

## Limits

- The bare Claude aliases resolved successfully in the coordinator’s subscription probes. Both `@latest` spellings returned 404 and are rejected by policy validation. Recorded identities describe those probes; the latest aliases can resolve to newer models later.
- No latest syntax was established for the other pinned provider paths. Their exceptions do not claim that every possible service-side alias was disproved.
- No routes, caps, scopes, fallback lists, spend permissions, or authority were widened. The work is committed on `bb/latest-model-tags` and opened as draft PR #25.

## Prose Checks

Round-2 latest-alias sections pass the Communication OS `technical-doc` linter with 0 errors. Shared README and routing profile each have 3 review warnings; Flora notes have none. The round-2 report passes with 0 errors and 30 review warnings for contextual wording and table density.

In round 1, the Communication OS linter ran with `--profile ~/.communication-os --route technical-doc`. The new latest-tag sections pass with 0 errors: shared README and routing profile each have 3 review warnings; Flora notes have none. Full shared README lint reports 18 errors and 96 warnings in existing sections. Those unrelated prose findings were left outside this change. The report passes with 0 errors. Review warnings remain for contextual pronouns and table density. The baseline shared README has the same 18 errors and 93 warnings; the 3 added warnings are in the new section.

The coordinator committed the tree after the sandbox blocked Git metadata writes.
