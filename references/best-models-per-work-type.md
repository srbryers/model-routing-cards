# Best AI Models per Software-Engineering Work Type — October 2026

> ⚠⚠ **BENCHMARK EVIDENCE. NOT POLICY.**
>
> - **Vendor benchmarks often exceeded independent reruns.** Where both exist,
>   self-reported scores ran **5–15 points** above independent measurement
>   (e.g. Grok 4.7 Terminal-Bench: 38% vendor vs 26% Artificial Analysis).
> - **Pricing was indexed, not live-verified.** Every price below came from web
>   coverage, not a vendor pricing page. Check before relying on it.
> - **This is input to policy.** The chosen routing policy is in
>   [`routing-profile.md`](../routing-profile.md), and it departs from this
>   report on purpose in places (e.g. Muse Spark as default builder).
> - **No routing card has been measured yet.** Every card in this repo is
>   `UNCALIBRATED`. A benchmark is someone else's task; a card is ours.
>
> Copied verbatim from the research report below this banner, except for this
> banner. The "Working notes" files in Sources are not in this repo.

**Research date:** 2026-10-02. **Method:** web index research (not live-verified on vendor pricing pages). Vendor self-reported benchmark numbers are flagged as such; independent measurements (Artificial Analysis, BenchLM, Vals, Kodus) are flagged where available.

## Executive summary

- The frontier for agentic coding is **Anthropic's Claude Opus 5.5** ($4/$20 per 1M in/out) — top of SWE-bench Pro (89.9%, vendor-reported), CursorBench 4.0 (57.8%), and the AA Coding Agent Index — with **Claude Sonnet 5.5** ($2/$10) as a near-parity workhorse that sometimes beats it (Terminal-Bench 4.0 70.6% vs 66.4%, vendor-reported) at the cost of much higher token burn at max effort.
- The "good enough and cheap" line has moved dramatically: **GPT-6 Sol / 6.1 Sol** ($2/$10, $1.06/AA-index-task vs Opus 5.5's $5.98), **Grok 4.7** ($2/$6), **Muse Spark 1.3** ($1.25/$4.25, DeepSWE 75.4%), and open-weight **DeepSeek V4 Pro** (~$0.435/$0.87) / **MiniMax M3** ($0.60/$2.40) / **GLM-5.2** ($1.40/$4.40 list).
- For code review, independent evidence says **no model is good enough to trust alone** (best recall 44.2% on real PRs — DeepSeek V4 Pro), so the right play is cheap high-recall first pass + expensive precision judge.
- For the router role, **GPT-6 Luna** ($0.10/$0.50, $0.07 per AA-index-task) and **Haiku-class** models are the natural picks; Haiku 5.5 was still unshipped as of Oct 1, 2026.

---

## 1. Agentic code implementation ("builder")

Multi-step feature building in an existing repo: read code, coherent edits, run tests, iterate.

### Recommended pick: Claude Opus 5.5 (Anthropic)
- **Pricing:** $4/M input, $20/M output; cache read $0.20/M (0.05×); 1M context, 128K max output. Batch API 50% off → $2/$10. GA Sep 22, 2026. API + Bedrock + GCP + Azure.
- **Evidence:**
  - SWE-bench Pro: **89.9%** (vendor-reported via Anthropic; BenchLM leaderboard, updated Oct 1, 2026 — leads Sonnet 5.5 81.3%, Fable 5.1 81.2%). Caveat: OpenAI's July 2026 audit estimated ~30% of the public split is broken; directional, not decisive.
  - DeepSWE v1.1 (Datacurve; 113 original, contamination-free tasks, up to 3h horizon): **74.2%** (Opus 5.5 system card).
  - CursorBench 4.0: **57.8% at max** — top of Cursor's leaderboard; still 52.5% at medium, above Fable 5.1 at max.
  - AA Coding Agent Index (Sep 9, 2026): **Claude Code + Opus 5.5 = 66** vs Codex + GPT-6 Astra 62.
  - Terminal-Bench 4.0: 66.4% (vendor, xhigh); 59.6% independently (Artificial Analysis).
- **Strengths:** best-published long-horizon scores; native Claude Code harness (best tool-use integration); 20% cheaper to run than Opus 5; cache economics (0.05× reads) favor agent loops.
- **When NOT to use:** budget-capped bulk work (cost/task is high — $5.98 per AA-index-task at max); when you need maximum token efficiency per quality point (GPT-6 Sol is ~5× cheaper per index task); latency-sensitive interactive loops; tasks where Sonnet 5.5 at high effort already passes your evals.

### Runner-up: Claude Sonnet 5.5 (Anthropic)
- **Pricing:** $2/$10 in/out; cache read $0.20/M; 1M ctx. GA Sep 28, 2026.
- **Evidence:** Terminal-Bench 4.0 **70.6%** (vendor — beats Opus 5.5's 66.4%, though not measured at identical effort); SWE-bench Pro 81.3%; CursorBench 4.0 55.5%; GDPval-AA 1844 (≈ Opus 5.5's 1846); AA Intelligence Index **56** (max), 2 pts behind Opus 5.5, 3 ahead of GPT-6 Astra; AA independent TB 4.0 63.6% vs Opus 5.5's 59.6%.
- **Caveat:** at max effort it burns ~193K output tokens/task — the highest AA has measured (~60% more than Opus 5.5), costing ~$7.60/task. Anthropic's guidance: run at medium/high, not max. At high effort it's ~1 point behind GPT-6 Sol on intelligence at the same cost/task.
- **When NOT to use:** max-effort unbounded runs (token blowup); genuinely novel architecture problems where Opus 5.5's reasoning depth shows (Anthropic: Opus "clearly stronger on complex, open-ended work").

### Third option (value): GPT-6 Sol / GPT-6.1 Sol (OpenAI)
- **Pricing:** $2/$10 in/out (launched Sep 22, 2026 at 50% off GPT-5.6 rates); cache 0.1×. 1.05M ctx. GPT-6.1 Sol shipped Sep 30 at same price.
- **Evidence:** AA Coding Agent Index 62 (Codex + GPT-6 Astra tuple); AA index-task cost **$1.06** vs Opus 5.5's $5.98; FrontierCode 1.1 49.3%; AA Intelligence Index 47.5 (max). Third-party: independent testers found Sol's Intelligence Index level with GPT-5.6 Sol with small regressions on some knowledge evals (HealthBench −3.8) — verify on your workload.
- **When NOT to use:** hardest long-horizon repos where Opus 5.5 leads by 8+ points on SWE-bench Pro; prompts >272K tokens (2×/1.5× price cliff).

### Price/performance frontier for builders
| Pick | $/1M in/out | Cost per AA-index-task | SWE-bench Pro | When |
|---|---|---|---|---|
| Opus 5.5 (frontier) | $4/$20 | $5.98 | 89.9% | hardest multi-hour work |
| Sonnet 5.5 (workhorse) | $2/$10 | ~$7.60 (max!) / much less at high | 81.3% | default for most coding |
| GPT-6.1 Sol (value) | $2/$10 | $1.06 | ~58.6% (GPT-5.5-era) | token-efficient agentic work |
| Muse Spark 1.3 (cheap alt) | $1.25/$4.25 | $0.219–1.43 | — / DeepSWE 75.4% | budget frontier-adjacent |
| DeepSeek V4 Pro (open) | ~$0.435/$0.87 | $0.27 (AA agent) | 55.4% | high-volume, validate harness first |

Note DeepSeek V4 Pro's AA Coding Agent Index is only 31.44 with reported tool/backend integration failures — its benchmark-to-agent gap is the largest; do not deploy on self-reported scores alone.

---

## 2. Code review and technical judgment ("judge")

### Key finding: no model clears 50% bug recall on real PRs
- Kodus benchmark (Aug 2026; 10 models × 30 merged PRs, scored against bugs humans actually flagged): top scorer **DeepSeek V4 Pro recall 44.2%** (precision 43.6%, $0.30/PR). Qwen3.8 Max 41.0%, Kimi K3 41.0%, Kimi K2.7 Code 37.9% at 50.0% precision ($0.55), DeepSeek V4 Flash 36.8% ($0.10), GLM 5.2 35.2% (47.0% precision, $0.88), MiniMax M3 25.3%, Gemini 3.7 Flash 11.6% but 73.9% precision ($0.27).
- Tool-level F1 (16,017 PRs): Greptile best precision (80.3%), Claude 62.5 F1, Copilot 63.9. Precision vs recall is the real tradeoff: precision = "developers act on it," recall = "don't assume clean means clean."
- AACR-Bench (200 PRs, 1,505 ground-truth comments): harness matters more than model — OpenCodeReview harness (Claude-4.6-Opus) SEM-F1 25.10% vs Claude Code /code-review (same model) 11.57%.

### Recommended pick: two-stage pipeline — cheap recall + frontier judge
- **Stage 1 (recall, cheap):** DeepSeek V4 Pro (44.2% recall, $0.30/PR) or GLM 5.2 (35.2% recall, 47.0% precision, $0.88/PR). 
- **Stage 2 (judgment):** **Claude Opus 5.5** or **Fable 5.1** (GDPval-AA 1846/1932 Elo; Fable 5.1 Max Terminal-Bench 4.0 57.9%, CursorBench 4.0 51.8%). Use the judge to *adjudicate and deduplicate* Stage-1 findings (like the STARK benchmark's blind-referee design), not to re-scan from scratch — this is where precision comes from.
- Qodo's testimonial data point: GPT-5.6 was "strongest on agentic code-review tests; ~3x fewer tokens/PR" — GPT-6 Sol is its cheaper successor for review loops.

### When NOT to use a single model as a merge gate
Never. Every measured model misses the majority of human-flagged bugs. Use AI review as a *comment generator* with human or high-precision adjudication, not a gate.

---

## 3. Debugging and bug fixing

Diagnosing failures from error output, localizing root cause, fixing.

### Recommended pick: Claude Opus 5.5
- **Evidence:** DeepSWE v1.1 74.2% (system card) — the best contamination-free bug-fix/feature benchmark; CursorBench 4.0 57.8% (ambiguous multi-file tasks from real sessions); SWE-bench Pro 89.9%. Anthropic's RL emphasis is on "recover from its own mistakes" (Terminal-Bench 4.0 design).
- Debugging is specifically the weak point of LLMs generally (Microsoft debug-gym study: even the best model solved <50% of SWE-bench Lite; failure mode = poor sequential information-seeking). So the pick is the model with the strongest *iterative* scores — Opus 5.5's CursorBench/DeepSWE lead — not the best single-shot patcher.
- Technique note (Syncause, Feb 2026): feeding the model **runtime facts** (dynamic traces) raised fix rates from 77.4% → 83.4% on SWE-bench Verified with Gemini 3 Pro — the harness/technique matters as much as the model for debugging.

### Runner-up: Grok 4.7 (xAI) — the debugging specialist on a budget
- **Pricing:** $2/$6 in/out (cached $0.50); 500K ctx; reasoning low→xhigh (default high). Available via xAI API, Cursor, Grok Build, Copilot, routers.
- **Evidence (vendor):** DeepSWE v1.1 71.0% at high effort (vs GPT-5.6 Sol 72.7%, Fable 5.1 70.0%); xAI explicitly trained it with "longer RL on harder multi-hour tasks" with self-verification; EEBench 64.0% (2nd only to GPT-6 Astra). Caveat: AA measured its Terminal-Bench at 26% vs 38% self-reported — discount vendor numbers ~10 pts.
- **When NOT to use:** when you need the absolute best localization on novel codebases (Opus 5.5); note output pricing $6 vs Sonnet's $10 — Grok wins on output-heavy debug loops.

### Cheap alternative: DeepSeek V4.1 Flash
- Off-peak ~$0.15/$0.60; vendor-claimed DeepSWE v1.1 74.2% (unverified — treat skeptically). V4 Pro at $0.435/$0.87 with 44.2% review recall is the safer cheap debugger.

---

## 4. Research and investigation

Deep web/codebase investigation producing sourced analysis.

### Recommended pick: Claude Opus 5.5 (tool-augmented)
- **Evidence:** HLE **with tools 67.7%** (vendor); GDPval-AA 1846 Elo (near Fable 5.1); Terminal-Bench-Science 59.0% (agentic research workflows); AA-Briefcase 1822. The pattern across sources: Claude leads when tools (search, code execution) are in the loop.
- **When NOT to use:** pure unaided STEM reasoning — Gemini 3.1 Pro leads GPQA Diamond (94.3%) and HLE without tools; long-context single-pass reads over an entire repo — Gemini's 1M+–2M window is built for that.

### Runner-up: GPT-6 Astra (OpenAI) — best agentic-research scores
- **Pricing:** $10/$50; 1.05M ctx.
- **Evidence:** Terminal-Bench-Science **63.3%** (leads Opus 5.5's 59.0%); GPT-5.5-era BrowseComp 90.1%; vendor claims ARC-AGI-3 99.9%, ExploitBench 100% (unverified, lab-chosen tests). AA Intelligence Index 53 (max) at $3.26/task — notably token-efficient for its tier.
- **When NOT to use:** cost-sensitive research (Fable 5.1 matches its AA index at 2× token price — both are expensive); verify lab-chosen benchmark claims independently.

### Budget pick: Gemini 3.1 Pro / Kimi K3
- Gemini 3.1 Pro ($2/$12 <200K; $4/$18 above): GPQA Diamond 94.3%, SWE-bench Verified 80.6%, biggest context — best for "read everything, then reason."
- Kimi K3 ($3/$15): IMO 2026 42/42, #1 SWE Marathon, #1 Frontend Arena — strongest open-weight analyst; thinking always-on/max by default (watch output-token bills).

---

## 5. Quick small edits (speed and cost matter most)

Single-file changes, refactors, mechanical transforms.

### Recommended pick: GPT-6 Luna (OpenAI)
- **Pricing:** **$0.10/$0.50** per 1M — cheapest frontier-lab model; $0.07 per AA-index-task (max). 1.05M ctx shared with Sol.
- **Evidence:** AA Intelligence Index 37.3 (max); DeepSWE v1.1 ~67 (per wccftech — credible tier for small edits); AutomationBench 20.7% (not a reasoning leader — fine for mechanical work).
- **When NOT to use:** anything needing multi-step reasoning (that's what Sol/Sonnet are for); note OpenAI's own data shows small regressions on some coding evals vs GPT-5.6 Luna — spot-check.

### Runner-up: Mercury 2.5 (Inception Labs, diffusion LM)
- **Pricing:** $0.20/$0.75; **440 tok/s** measured on OpenRouter (P50) — ~5× Haiku 4.5, ~3.4× Luna. 260K ctx. The latency pick for inline/IDE completions.
- **When NOT to use:** complex refactors (reasoning depth is the tradeoff for diffusion speed); 260K ctx ceiling.

### Cheap open alternatives
- **DeepSeek V4 Flash** ($0.14/$0.28, MIT, 1M ctx): 36.8% code-review recall at $0.10/PR — the cheapest "actually competent" small model.
- **Qwen3-Coder-Next** (~$0.11/$0.80, Apache-2.0, 151 tok/s, runs on 46GB locally): 6/6 on DataLLM's coding-task battery at 36× cheaper than Opus.
- **Gemini 3.5 Flash-Lite** ($0.30/$2.50, 382 tok/s) — but price **doubles Jan 1, 2027** (scheduled).
- **Haiku 5.5**: announced "coming weeks" (late Sep 2026), not yet GA as of Oct 1 — wait for it if you're standardized on Anthropic (Haiku 4.5 is $1/$5 today).

---

## 6. Task routing/classification ("router")

Reads a task description, picks the specialist model.

### Recommended pick: GPT-6 Luna
- Why: $0.10/$0.50, $0.07/task, ~129 tok/s class, 1.05M ctx (can read big task descriptions + repo pointers), and it shares the GPT-6 family prompt behavior — same instruction-following lineage as the models it routes to. Routing is a classification + structured-output job, not a reasoning job; Luna's AutomationBench 20.7% weakness is irrelevant here.
- Alternative: **Gemini 3.5 Flash-Lite** ($0.30/$2.50, 382 tok/s) if you're on Google infra; **Haiku 4.5** ($1/$5) if Anthropic-only — but both are 3–10× pricier per token than Luna.
- Escalation pattern that works (per DataLLM Lab's measured workload): **cheap-first with escalation** — GLM-5.2/Qwen/DeepSeek handled 6/6 routine coding tasks; route only the failures/uncertain ones to Opus.

### What makes a good router vs a good judge
- **Router (classification):** latency and cost per call dominate — it runs on *every* task. Needs: strong instruction-following (IFBench-type), reliable structured/JSON output, enough context for the task description, good calibration (a router that confidently misroutes is worse than one that escalates on uncertainty), low hallucination rate. Reasoning depth is nearly irrelevant; abstention behavior matters more.
- **Judge (generation + adjudication):** reasoning depth at high effort, domain expertise, **precision over recall** (the Greptile lesson: 80.3% precision is what makes developers act), consistency across runs, grounding in the actual diff (not vibes). Use an **orthogonal model family** from the generator when possible (e.g., Gemini-family critic over Claude-generated code) so failure modes don't correlate — the multi-vendor setup guides explicitly recommend this.

---

## Model-family availability (API, Oct 2026)

| Family / model | API status | $/1M in/out | Notes |
|---|---|---|---|
| Claude Opus 5.5 | ✅ Anthropic, Bedrock, GCP, Azure, OpenRouter | $4/$20 | current flagship builder |
| Claude Sonnet 5.5 | ✅ same | $2/$10 | GA Sep 28, 2026 |
| Claude Fable 5.1 | ✅ | $10/$50 | top knowledge-work Elo (1932) |
| Claude Mythos 5 | ⚠️ **invite-only** ($10/$50) | — | gated |
| Claude Haiku 5.5 | ⚠️ announced, **not yet GA** (as of Oct 1) | — | Haiku 4.5 ($1/$5) current |
| Opus 4.7 / Sonnet 4.6 | ⚠️ legacy | — | superseded |
| GPT-6 Astra | ✅ OpenAI API, Codex | $10/$50 | GA Sep 3, 2026 |
| GPT-6 / 6.1 Sol | ✅ | $2/$10 | 6.1 shipped Sep 30 |
| GPT-6 Luna | ✅ | $0.10/$0.50 | router/small-edit pick |
| GPT-6 Terra | ❌ never shipped | — | vaporware |
| GPT-5.6 family | ⚠️ superseded; Sol promo $4/$20 thru Nov 21, 2026 | — | legacy |
| gpt-5.5-pro | ✅ (niche) | $30/$180 | ultra-premium |
| Gemini 3.1 Pro | ⚠️ **preview** ($2/$12 <200K) | — | GA Pro missing in 3.x line |
| Gemini 3.8 Flash | ✅ | not pinned | TB 2.1 leader (89.4%) |
| Gemini 3.5 Flash-Lite | ✅ | $0.30/$2.50 | price doubles Jan 2027 |
| Grok 4.7 | ✅ xAI API, Cursor, Copilot, routers | $2/$6 | closed weights; xAI now "SpaceXAI" |
| DeepSeek V4 Pro / Flash | ✅ official API, OpenRouter, Together | ~$0.435/$0.87 / $0.14/$0.28 | **MIT**; pricing conflict flagged (docs also show $1.74/$3.48 post-promo) |
| deepseek-chat / reasoner | ❌ retired Jul 24, 2026 | — | deprecated |
| MiniMax M3 | ✅ official API, OpenRouter | $0.60/$2.40 ($0.30/$1.20 promo) | open-weight, **conditional license** |
| GLM-5.x (Z.ai) | ✅ (API had waitlist; now open) | $1.40/$4.40 list; ~$0.55/$1.85 3rd-party | MIT/Apache-2.0 weights; Coding Plan subscription |
| Kimi K3 (Moonshot) | ✅ official API, OpenRouter | $3/$15 | open weights; **license conflict**: custom revenue-capped license per some sources, Apache-2.0 per others — read before commercial use |
| Qwen3-Coder-Next / 3.6 | ✅ Alibaba Cloud, OpenRouter | $0.11/$0.80 / ~$0.325/$1.95 | Apache-2.0 |
| Muse Spark 1.3 (Meta) | ✅ Meta Model API (**US-only** at launch) | $1.25/$4.25; contributor $0.10/$0.20 | closed; open weights promised, not delivered |
| Llama 5 | ❌ not shipped; forecast 2027 | — | vaporware for now |
| Mercury 2.5 (Inception) | ✅ OpenRouter | $0.20/$0.75 | fastest measured (440 tok/s) |
| Composer 2.5 (Anysphere) | ✅ via Cursor CLI | fast tier $0.55/task (AA) | xAI acquired Anysphere in 2026 |

**Conflicts / uncertainty to flag:** (1) DeepSeek V4 Pro pricing — Aug 2026 GA coverage says $0.435/$0.87 carries over; official docs earlier showed promo ending May 31, 2026 → $1.74/$3.48. Verify at billing time. (2) SWE-bench Pro rows are vendor-reported across different scaffolds; OpenAI's audit says ~30% of the public split is broken. (3) Vendor self-reported scores (esp. xAI, MiniMax, Meta, Moonshot) run 5–15 pts above independent re-runs where both exist. (4) Kimi K3 license terms conflict across sources. (5) Sonnet 5.5's headline benchmark wins are partly effort-setting artifacts (70.6% TB 4.0 not at matched effort vs Opus).

---

## Could not verify
- Exact GPT-6 Sol SWE-bench Pro number (only GPT-5.5's 58.6% and Sol's FrontierCode 49.3% found; Sol's coding-agent standing comes from the AA Coding Agent Index tuple score).
- Gemini 3.8 Flash API list pricing (only cost/task $1.24 found).
- Whether Haiku 5.5 shipped between Sep 28 and Oct 2, 2026 (announced "coming weeks").
- Muse Spark 1.3 availability outside the US / on aggregators.
- Independent reproduction of DeepSeek V4 Pro 0813's 80.6% SWE-bench Verified and V4.1 Flash's 74.2% DeepSWE.

## Sources
All sources read 2026-10-02 via web index (URLs verbatim):
- Benchmarks: https://benchlm.ai/benchmarks/swe-bench-pro, https://benchlm.ai/benchmarks/swe-rebench, https://benchlm.ai/benchmarks/swe-bench-verified, https://benchlm.ai/benchmarks/cursorbench, https://llm-stats.com/benchmarks/swe-bench-verified
- Anthropic: https://codersera.com/blog/claude-sonnet-5-5-complete-guide-2026/, https://www.marktechpost.com/2026/09/28/anthropic-releases-claude-sonnet-5-5-70-6-on-terminal-bench-4-0-at-the-same-2-10-price/, https://www.neowin.net/news/anthropic-launches-sonnet-55-model-to-take-on-openais-gpt-6-sol-at-the-same-api-price/, https://www.unite.ai/anthropic-releases-claude-sonnet-5-5-at-unchanged-sonnet-5-pricing/, https://emergent.sh/learn/claude-opus-5-5-vs-claude-sonnet-5, https://agentriot.com/news/ai-models/claude-sonnet-5-5-api-pricing-speed-task-cost
- Independent analysis: https://artificialanalysis.ai/articles/claude-sonnet-5-5, https://officechai.com/ai/claude-sonnet-5-5-scores-56-on-artificial-analysis-intelligence-index-3-points-ahead-of-gpt-6-astra/, https://the-decoder.com/anthropics-claude-sonnet-5-5-nearly-matches-opus-5-5-on-benchmarks-while-costing-up-to-30-percent-less-per-task/, https://www.datacamp.com/blog/best-llm-for-coding, https://www.swfte.com/ai/leaderboard, https://www.swfte.com/ai/models
- OpenAI: https://www.pk-sharma.com/briefing/openai-gpt-6-sol-luna-half-price-competitor-numbers, https://kingy.ai/blog/claude-opus-5-5-vs-gpt-6-astra-vs-gpt-5-6-sol/, https://www.explainx.ai/blog/gpt-6-sol-luna-launch-pricing-2026, https://www.digitalapplied.com/blog/gpt-6-sol-luna-launch-pricing-benchmarks-2026?ref=implicator.ai, https://wccftech.com/openai-unleashes-a-new-price-war-with-gpt-6-sol-and-gpt-6-luna-now-priced-below-claude-opus-5-5-and-deepseeks-v4-1-flash-respectively-negating-the-rationale-for-open-weight-models/
- Google: https://tokenmix.ai/blog/gemini-3-1-pro-api-pricing-review, https://dev.to/shaam_ai/best-llm-for-coding-in-2026-claude-opus-48-vs-gpt-55-vs-gemini-31-pro-with-enterprise-pn9, https://aireiter.com/blog/best-llm-for-coding-agents-2026, https://tech-insider.org/sonnet-5-5-vs-gpt-6-luna-vs-gemini-3-8-2026/
- xAI: https://www.winzheng.com/en/article/grok-4-7-deepswe-71-benchmark-pricing-analysis, https://www.marktechpost.com/2026/09/21/spacexai-releases-grok-4-7/, https://aiweekly.co/alerts/xai-ships-grok-47-at-26-per-million-tokens-deepswe-71, https://aireleasetracker.com/model/xai/grok-4.7, https://tokenscost.com/blog/grok-4-7-pricing-context-window-benchmarks
- DeepSeek: https://github.com/zerx-lab/zerx-lab-website/blob/HEAD/src/content/posts/daily-tech-news-2026-08-12/en.md, https://github.com/pedro-bright/the-ledger/blob/HEAD/content/events/2026/30-deepseek-v4-pro-release.md, https://github.com/full-stack-assets/wireandlogic/blob/HEAD/content/posts/deepseek-v4-pro-0813-release.mdx
- MiniMax: https://lushbinary.com/blog/minimax-m3-vs-m2-7-whats-new-upgrade-guide/, https://www.morphllm.com/minimax-m3, https://tech-insider.org/ca/minimax-m3-open-weight-llm-2026/
- Moonshot/Kimi: https://dev.to/mecanik-dev/kimi-k3-api-pricing-integration-and-trade-offs-2opn, https://github.com/api-evangelist/hashnode/blob/HEAD/blogs/2026-08-01-kimi-k3-took-first-place-on-frontend-coding-at-a-third-of.md, https://pureai.com/articles/2026/07/17/china-moonshot-ai-releases-kimi-k3.aspx
- Z.ai/GLM & Qwen: https://tech-insider.org/deepseek-v4-vs-glm-5-2-vs-qwen-2026/, https://www.morphllm.com/best-open-source-coding-model-2026?ref=hackernoon.com, https://www.datallmlab.com/blog/claude-code-with-glm-5.html
- Meta: https://witho2.com/news/meta-muse-spark-1-1-agentic-model-api, https://stackfutures.com/blog/muse-spark-1-3-livebench-cost-per-task-frontier-value-sept-2026/, https://tech-insider.org/muse-spark-vs-gpt-6-astra-vs-claude-fable-2026/
- Code review: https://github.com/kodustech/codereviewbench/blob/HEAD/src/content/blog/ai-code-review-recall-2026.mdx, https://dev.to/tessainsley/a-code-review-benchmark-that-isnt-the-vendor-ranking-itself-4jp6, https://quashbugs.com/blog/ai-code-review-statistics
- Agent/harness research: https://github.com/srdjancoric/baby-tracker/blob/HEAD/plans/research/tdd-coding-model-speed-quality-2026-08.md, https://github.com/kamil1721/coding-agent/blob/HEAD/docs/research/01-model-billing-and-architecture.sources.md, https://github.com/shaharsha/claude-skills/blob/HEAD/skills/prompt-engineer/references/model-selection.md, https://github.com/chrishuffman5/domain-expert/blob/HEAD/plugins/ai/skills/model-selection/SKILL.md, https://github.com/pedroknigge/orderfield/blob/HEAD/docs/model-catalog.md
- Small/fast: http://dev.to/shaam_ai/fastest-llm-2026-mercury-25-beats-luna-and-haiku-2nef
- DeepSWE methodology: https://github.com/gokr/niffler/blob/HEAD/bench/deepswe/README.md, https://github.com/hj1105/kontext-brain-ts/blob/HEAD/bench/data/deepswe-methodology-review-2026-09-03.md
- Working notes: notes/source-notes.md, notes/source-notes-2.md
