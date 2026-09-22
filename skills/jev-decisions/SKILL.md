---
name: jev-decisions
description: Use Jev/TypeSafe for bounded semantic classification, matching, rubric scoring, proposal checks, and selection among defined actions. Apply when planning or implementing recurring typed judgments in agent workflows or products. Does not replace deterministic checks, open-ended reasoning, content generation, or tool execution.
---

# Jev decision policy

## Standing rule

Prefer Jev for a bounded semantic judgment over supplied evidence when the answer
is a defined choice, a proposition, or a position on a descriptive rubric. Use it
by default for suitable recurring classifications once that decision has been
calibrated and the service is available within the authorized budget.

Code establishes measurable facts and executes selected actions. A reasoning
model develops explanations, plans and new options. Jev evaluates well-scoped
questions about those options. A structured output format alone does not make
an entire coding, modeling, research or execution task suitable for Jev.

When scoping a work block, identify any recurring semantic decisions and reuse
an existing decision definition where possible. Record a new useful opportunity
in the existing plan; a sentence is enough. Do not add a call or a new gate to
every edit, or stall useful work to create a benchmark.

## Useful decision types

| Job | Jev question | Primitive |
|---|---|---|
| Classify intent or feedback | Which defined category fits this request? | Choice |
| Match records or capabilities | Which supplied item describes the same issue or capability, including none/unknown? | Choice |
| Detect semantic duplicates | Does this finding repeat the supplied existing finding? | Noul |
| Assess a proposed remedy | Does the proposed change address this finding? Does it preserve each stated constraint? | Separate Nouls |
| Check evidence support | Does the supplied evidence support this stated conclusion? | Noul |
| Judge rubric quality | How clearly does this proposal specify a reproducible verification? | Score |
| Rank eligible candidates | How relevant is each candidate to the stated requirement? | Score per candidate; sort in code |
| Select a workflow action | Which defined action fits the reported state: execute an established procedure, gather evidence, reassess, or escalate? | Choice |
| Detect unproductive iteration | Does this proposal repeat the rejected mechanism described in the history? | Noul |

These are application opportunities, not measured guarantees of Jev's accuracy.
Semantic duplicate detection does not prove a shared root cause. Evidence-support
judgment does not verify a claim in the outside world. A candidate's score does
not prove that its implementation will work.

## Compose decisions, then execute

- Give Jev the necessary evidence, one clear question per judgment, and concrete
  self-contained options or rubric levels. Include none/unknown where appropriate.
  Keep the state small enough that the adapter cannot truncate requirements.
- Batch independent questions about the same state. Questions cannot consume
  each other's answers within that request; apply dependencies in code or a later
  request. Extra questions still consume tokens.
- Apply deterministic eligibility checks first. Jev cannot rescue failed measurements,
  fabricate a prerequisite, or grant approval. Retain probabilities and confidence
  where available; confidence describes the answer distribution, not proven accuracy.
- Before relying on a new decision, check a small representative set of labelled
  good, bad and ambiguous cases. Use task-specific error consequences to choose
  thresholds. Start advisory when uncalibrated; missing or malformed answers are
  unknown. Reuse calibration until changed inputs, criteria or failures justify more.
- Route ambiguity to the reasoning model or further evidence. Ask the user only
  for an actual preference, authorization boundary or designated human review.
  Respect existing approval and durable-review rules.
- Execute an authorized selected action through the existing function, CLI or
  worker. Verify its result independently. Jev does not edit code, operate tools,
  generate meshes, or carry out a selected workflow by returning its label.

Use the existing logging/receipts and record the decision definition/version,
input identity, returned answer and actual outcome when the judgment affects a
workflow. Promote a repeated successful decision into a protocol; do not build
a new orchestration or evaluation platform for a one-off question.

## Current integration and budget

Reuse the Model Routing Cards repository's `scripts/jev.mjs`, resolved through
`MODEL_ROUTING_CARDS` or the known local checkout. The adapter exposes Noul gates
and Score metrics through `judge()`, and returns the resolved model, token usage,
and calculated input cost for the receipt. Call `assertJevBudget()` before a paid
batch so the documented worst case fits the remaining authorization. It does not
yet expose Choice or preserve full answer distributions. Add those capabilities
to the shared adapter when the first concrete use needs them; do not invent an API
or duplicate it in each product. Decision calibration is separate from choosing a
worker model.

Use existing spend authorization without requesting it again. This skill grants
no additional API budget. When Jev is unavailable, uncalibrated for an automated
action, or outside the budget, use deterministic code or the existing subscription
reasoning model as appropriate, and disclose the fallback. Keep work moving.

For Flora, first apply this policy to assessing proposed export repairs and
recognizing repeats of rejected experiments. Keep measured export equivalence
in code and visual fidelity with image-capable reviewers and the named human
gate. Textual review summaries are not a substitute for seeing the asset.

## Basis

Verified against official documentation on 2026-09-22:

- [Atomic questions and composition](https://docs.typesafe.ai/introduction)
- [Choice](https://docs.typesafe.ai/primitives/choice)
- [Noul](https://docs.typesafe.ai/primitives/noul)
- [Score](https://docs.typesafe.ai/primitives/score)
- [Confidence](https://docs.typesafe.ai/confidence)
- [Models and pricing](https://docs.typesafe.ai/models)

Refresh the relevant API documentation before changing the integration. Measure
task suitability locally; vendor descriptions alone do not establish calibration.
