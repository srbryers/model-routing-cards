# Cloudflare Clef adapter

`scripts/clef.mjs` adds the hosted Cloudflare Clef REST transport alongside the
existing Jev adapter. It accepts the System One `noul`, `choice`, and `score`
question forms and returns each answer's type, known/unknown status, selected
answer (when applicable), complete option distribution, confidence, and raw
answer. Missing, malformed, incomplete, or selector-mismatched answers are
`unknown`; callers must not treat them as a pass. A returned model mismatch
makes all answers unknown.

```js
import { clef, assertClefBudget } from './scripts/clef.mjs';

assertClefBudget({ model: 'clef', limitUsd: 0.10, maxRequests: 1 });
const result = await clef({
  accountId: 'cloudflare-account-id',
  model: 'clef',
  state: { evidence: '...' },
  questions: {
    supported: { type: 'noul', instructions: 'Does the evidence support the claim?' },
    action: {
      type: 'choice', instructions: 'Which defined action fits?',
      criteria: { execute: 'Run the established procedure', unknown: 'Gather more evidence' },
    },
    clarity: {
      type: 'score', instructions: 'How reproducible is the proposed check?',
      criteria: ['No reproducible check', 'Check is partly specified', 'Check is fully reproducible'],
    },
  },
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
});
```

Credentials are read only when the call is made and must be explicitly supplied
through `apiToken` or the lazy `readToken` callback. `fetchImpl` can be injected
for offline callers. The adapter performs one request, with no retry, and caps
the timeout at 30 seconds through response-body parsing. It refuses oversized
serialized state plus question schema by UTF-8 byte count (12 KiB); it never
relies on the API's silent context truncation. It
supports the documented embedded PNG/JPEG/WebP forms and checks encoded bytes,
header dimensions, and published per-image, aggregate, pixel, and request-body
limits. Hosted video input is intentionally unsupported.

The output separates `requestedModel` and observed `resolvedModel`. The public
API does not expose an immutable model revision, so `modelRevision` is
explicitly `null`. Token cost is an estimate from returned input-token usage and Cloudflare's published
input rates ($0.24/M for `clef`, $0.09/M for `clef-flash`); absent/unusable usage
or a resolved-model mismatch produces a null estimate. The complete provider
result and raw usage are retained for receipts. Pricing and limits were checked
against Cloudflare's [Clef model schema](https://developers.cloudflare.com/workers-ai/models/clef/)
and [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
on 2026-10-03.
