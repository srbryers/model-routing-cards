
## Communication OS

Prose in this repo follows the Communication OS profile at ~/.communication-os. Adapters are generated from the profile and never edited by hand. Before drafting or revising user-visible copy, docs, or PR text, apply the profile rules for the surface and lint the draft with the profile linter.

## Next steps come from the project, not the last message (Sebastian, 2026-10-27)
- Never present a "next step" as the real next step unless it is derived from this project's actual state: its locked plan, its gates, its open decisions, what is blocked on what. A suggestion that only follows from the last message's momentum is not a next step; label it an idea, or do not offer it.
- Before naming a next step, check the project context (plan/roadmap state, goal file, open gates). If a pitched step does not survive that check, correct it in the same conversation, plainly.

## GitHub text is never hard-wrapped (Sebastian, 2026-10-28)
- Text written for GitHub (PR bodies, issue bodies, review comments) is never hard-wrapped: one paragraph or one bullet is one long line. GitHub keeps single line breaks in comments, so a draft wrapped at 70-80 chars renders as a narrow column inside GitHub's already-fixed comment column. (Named from ui-kit PR #217, 2026-10-28, where the PR body was drafted as a wrapped file and posted as-is.)
- Files inside this repo keep the repo's wrapped style; the rule is about text posted to GitHub. Unwrap a draft before posting it.
