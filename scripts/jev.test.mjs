import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertJevBudget, jevInputCostUsd, JEV_PRICING } from './jev.mjs';

test('Jev cost uses published input-token pricing and ignores free output tokens', () => {
  assert.equal(jevInputCostUsd({ input_tokens: 1_000_000, output_tokens: 999_999 }), 0.042);
  assert.equal(jevInputCostUsd({ input_tokens: 2_866, output_tokens: 384 }), 0.000120372);
});

test('budget reserves the documented maximum before any request is sent', () => {
  const preflight = assertJevBudget({ limitUsd: 10, spentUsd: 0.000120372, maxRequests: 6 });
  assert.equal(preflight.reserveUsd, 0.016128);
  assert.equal(preflight.remainingUsd, 9.999879628);
  assert.equal(JEV_PRICING.maxInputTokensPerRequest, 64_000);
});

test('budget refuses a batch whose worst case exceeds the remaining authorization', () => {
  assert.throws(
    () => assertJevBudget({ limitUsd: 0.01, spentUsd: 0, maxRequests: 4 }),
    /Jev budget refused/,
  );
});
