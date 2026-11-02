
## Communication OS

Prose in this repo follows the Communication OS profile at ~/.communication-os. Adapters are generated from the profile and never edited by hand. Before drafting or revising user-visible copy, docs, or PR text, apply the profile rules for the surface and lint the draft with the profile linter.

## Next steps come from the project, not the last message (Sebastian, 2026-10-27)
- Never present a "next step" as the real next step unless it is derived from this project's actual state: its locked plan, its gates, its open decisions, what is blocked on what. A suggestion that only follows from the last message's momentum is not a next step; label it an idea, or do not offer it.
- Before naming a next step, check the project context (plan/roadmap state, goal file, open gates). If a pitched step does not survive that check, correct it in the same conversation, plainly.

## GitHub text is never hard-wrapped (Sebastian, 2026-10-28)
- Text written for GitHub (PR bodies, issue bodies, review comments) is never hard-wrapped: one paragraph or one bullet is one long line. GitHub keeps single line breaks in comments, so a draft wrapped at 70-80 chars renders as a narrow column inside GitHub's already-fixed comment column. (Named from ui-kit PR #217, 2026-10-28, where the PR body was drafted as a wrapped file and posted as-is.)
- Files inside this repo keep the repo's wrapped style; the rule is about text posted to GitHub. Unwrap a draft before posting it.

## Long-term architecture first, on every project (Sebastian, 2026-10-29)
- For any recommended plan or decision, on every project Sebastian works on, always opt for the correct long-term scalable architecture: one system per platform sharing contracts, shared token sets over pasted values, records as the source of truth over hand-typed copies, no local forks, no second renderer on one page to save a port.
- The only exception is quick prototyping, and it must be labelled as such when used: a prototype is a throwaway check, not a foundation, and it must never be copied forward as the build (as the Taura website job's simplified screens were copied into two drafts on 2026-10-28/29).
- When a short-term route is cheaper or faster, say so plainly and still recommend the long-term route, with the cost and the fidelity gap of each named. Do not let a cheap route become the plan by default.

## Content in every design passes Communication OS checks first (Sebastian, 2026-11-02, ALL projects, always)
- His words: "That needs to be the case with ALL content in ALL designs ALWAYS across ALL apps. Or projects."
- Every piece of user-visible content in any design - specimens, concept boards, surfaces, review packets, shipped UI copy - passes the Communication OS app-content checks before it is shown to Sebastian, on every project, with no exception for speed. Content uses the real record's words where the app would show record text; model-paraphrased filler that reads like AI slop is a defect, not a style choice.
- The measured gate (layout, tap targets, palette, states) does not cover this. A board that has passed only the measured gate is not ready to show him; the COS pass is a named line in every concept/design gate record, next to the measured gate.
- First failure, same day: the Jawanna clip concept boards reached him with no COS pass and the check had to be run after he asked. Do not repeat it.

## Design learnings are shared across all projects (Sebastian, 2026-11-02, "applied to and shared across all my projects")
- A design learning won on one project is a fleet asset, not a local note: it is written into the shared rules (this file) and the shared DESIGN constitution, and every project's design work is checked against it. What transfers is the method and the bar, never another product's look - each project keeps its own DESIGN.md, tokens, and identity.
- The current shared set, starting with the Jawanna clip rounds of 2026-11-02:
  1. Image-led where the product has a chosen image: the surface leads with the selected picture (generated, photo, or the standard design), and every fallback kind is designed, never defaulted. One system whose hero changes with the content beats a separate design per case.
  2. The first surface a stranger sees carries the highest craft bar: beautiful and slick, with the motion designed (settling in, responding to a pick, the result moment resolving), not just the static happy path.
  3. Concept specimens that will be judged for acceptance are built on the proper design seat; quick-seat specimens are throwaway exploration only (Jawanna Family A round 1 was rejected on craft for exactly this, 2026-11-02).
  4. Two gates before anything is shown to Sebastian: the measured gate and the Communication OS content gate (see the content rule above). Real content only: real record words, real art and photos, no placeholder boxes or paraphrased filler.
  5. Copy states only what the system can truthfully say at that moment (the clip receipt says "received", never "counted", until a member's app picks the vote up) - honesty constraints are designed in, not patched after.
  6. Known gaps are named on the board itself and ride with acceptance as corrections (single-pick specimens against approval-voting rules), never slid in silently.
- Already-standing rules these sit beside, unchanged: lowest impact / easiest to understand; design in context, never in isolation; concept approval before build.
