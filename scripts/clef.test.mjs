import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertClefBudget,
  clef,
  clefInputCostUsd,
  CLEF_PRICING,
  normalizeSystemOneAnswers,
  validateClefRequest,
} from './clef.mjs';

const spec = {
  accountId: 'abc123',
  state: { issue: 'Checkout fails for all customers.' },
  questions: {
    urgent: { type: 'noul', instructions: 'Is the incident urgent?' },
    team: {
      type: 'choice', instructions: 'Which team owns the incident?',
      criteria: { billing: 'Payments and invoices', technical: 'Outages and errors' },
    },
    severity: {
      type: 'score', instructions: 'Rate the impact.',
      criteria: ['No impact', 'Some users affected', 'All users affected'],
    },
  },
};

function envelope({ model = 'clef', answers, usage = { input_tokens: 1000, output_tokens: 20 } } = {}) {
  return { success: true, result: { model, answers, usage } };
}

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function completeAnswers() {
  return {
    urgent: { type: 'noul', noul: 0.8 },
    team: { type: 'choice', choice: 'technical', probabilities: { billing: 0.1, technical: 0.9 }, confidence: 0.9 },
    severity: { type: 'score', score: 1.7, legend: { 0: 'No impact', 1: 'Some users affected', 2: 'All users affected' }, probabilities: { 0: 0.05, 1: 0.2, 2: 0.75 }, confidence: 0.75 },
  };
}

test('validates typed questions and serializes a small request without credentials', () => {
  const prepared = validateClefRequest(spec);
  assert.equal(prepared.stateBytes, Buffer.byteLength(JSON.stringify(spec.state)));
  assert.deepEqual(JSON.parse(prepared.body).questions, spec.questions);
});

test('rejects untrusted selectors and unsafe IDs before auth or network', async () => {
  let readTokenCalls = 0;
  let fetchCalls = 0;
  await assert.rejects(clef({ ...spec, model: 'clef-v2', readToken: async () => { readTokenCalls++; return 'secret'; }, fetchImpl: async () => { fetchCalls++; } }), /model must be/);
  await assert.rejects(clef({ ...spec, questions: { 'bad id': spec.questions.urgent }, readToken: async () => { readTokenCalls++; return 'secret'; }, fetchImpl: async () => { fetchCalls++; } }), /safe characters/);
  await assert.rejects(clef({ ...spec, questions: { x: { type: 'choice', instructions: 'Pick one', criteria: { only: 'one' } } }, readToken: async () => { readTokenCalls++; return 'secret'; }, fetchImpl: async () => { fetchCalls++; } }), /2 to 255 options/);
  assert.equal(readTokenCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('refuses oversized Unicode state in UTF-8 bytes without truncation or auth', async () => {
  let calls = 0;
  const state = '🌴'.repeat(4000);
  assert.ok(Buffer.byteLength(JSON.stringify(state), 'utf8') > CLEF_PRICING.maxStateBytes);
  await assert.rejects(clef({ ...spec, state, readToken: async () => { calls++; return 'secret'; }, fetchImpl: async () => { calls++; } }), /UTF-8 bytes.*never truncated/);
  assert.equal(calls, 0);
});

test('the 12 KiB ceiling covers serialized state plus the question schema', () => {
  const questions = { x: { type: 'noul', instructions: 'q'.repeat(5000) } };
  assert.ok(Buffer.byteLength(JSON.stringify(spec.state), 'utf8') < CLEF_PRICING.maxStateBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(questions), 'utf8') < CLEF_PRICING.maxStateBytes);
  assert.throws(() => validateClefRequest({ ...spec, state: 's'.repeat(8000), questions }), /state and questions.*maximum.*never truncated/);
});

test('supports embedded PNG data URLs and rejects remote URLs, malformed data, and oversized dimensions', () => {
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(2, 16);
  png.writeUInt32BE(3, 20);
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  assert.equal(validateClefRequest({ ...spec, images: [dataUrl] }).decodedImageBytes, 24);
  assert.throws(() => validateClefRequest({ ...spec, images: ['https://example.com/p.png'] }), /remote URLs/);
  assert.throws(() => validateClefRequest({ ...spec, images: ['data:image/png;base64,not-base64!'] }), /base64 data URL/);
  const huge = Buffer.from(png);
  huge.writeUInt32BE(5000, 16);
  huge.writeUInt32BE(4000, 20);
  assert.throws(() => validateClefRequest({ ...spec, images: [`data:image/png;base64,${huge.toString('base64')}`] }), /16 megapixels/);
  assert.throws(() => validateClefRequest({ ...spec, video: 'data:video/mp4;base64,...' }), /video input is unsupported/);
  assert.throws(() => validateClefRequest({ ...spec, videos: ['data:video/mp4;base64,...'] }), /video input is unsupported/);
});

test('normalizes all three decision types while retaining complete distributions and provenance', async () => {
  let request;
  const out = await clef({
    ...spec,
    apiToken: 'explicit-token',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(envelope({ answers: completeAnswers() }));
    },
  });
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/cloudflare/clef');
  assert.equal(request.init.headers.Authorization, 'Bearer explicit-token');
  assert.equal(JSON.parse(request.init.body).model, 'clef');
  assert.equal(out.requestedModel, 'clef');
  assert.equal(out.resolvedModel, 'clef');
  assert.equal(out.modelRevision, null);
  assert.deepEqual(out.answers.team.distribution, { billing: 0.1, technical: 0.9 });
  assert.deepEqual(out.answers.severity.distribution, { 0: 0.05, 1: 0.2, 2: 0.75 });
  assert.deepEqual(out.answers.urgent.distribution, { false: 0.2, true: 0.8 });
  assert.equal(out.answers.severity.score, 1.7);
  assert.equal(out.usage.inputTokens, 1000);
  assert.equal(out.cost.inputUsd, 0.00024);
  assert.equal(out.cost.basis, 'published-input-token-estimate');
});

test('shared System One normalizer accepts a raw answer map without a Cloudflare envelope', () => {
  const normalized = normalizeSystemOneAnswers(spec.questions, completeAnswers());
  assert.equal(normalized.team.status, 'known');
  assert.equal(normalized.team.selected, 'technical');
  assert.deepEqual(normalized.team.distribution, { billing: 0.1, technical: 0.9 });
  assert.equal(normalized.severity.status, 'known');
  assert.equal(normalized.urgent.probabilityYes, 0.8);
  const missing = normalizeSystemOneAnswers(spec.questions, { team: completeAnswers().team });
  assert.equal(missing.urgent.status, 'unknown');
});

test('missing answers and malformed or mismatched probabilities become unknown', async () => {
  const answers = completeAnswers();
  delete answers.urgent;
  answers.team.probabilities.technical = '0.9';
  answers.severity.probabilities[2] = NaN;
  const out = await clef({ ...spec, apiToken: 'token', fetchImpl: async () => response(envelope({ answers })) });
  assert.equal(out.answers.urgent.status, 'unknown');
  assert.equal(out.answers.team.status, 'unknown');
  assert.equal(out.answers.severity.status, 'unknown');
  assert.equal(out.answers.urgent.reason, 'missing_or_type_mismatch');
});

test('a selector that disagrees with the returned choice becomes unknown', async () => {
  const answers = completeAnswers();
  answers.team.choice = 'billing';
  const out = await clef({ ...spec, apiToken: 'token', fetchImpl: async () => response(envelope({ answers })) });
  assert.equal(out.answers.team.status, 'unknown');
  assert.equal(out.answers.team.reason, 'selector_mismatch');
});

test('a mismatched resolved model makes every answer unknown and the cost unavailable', async () => {
  const out = await clef({
    ...spec,
    model: 'clef-flash',
    apiToken: 'token',
    fetchImpl: async () => response(envelope({ model: 'clef', answers: completeAnswers() })),
  });
  assert.equal(out.modelMatchesRequest, false);
  assert.equal(out.answers.team.status, 'unknown');
  assert.equal(out.cost.inputUsd, null);
});

test('an omitted resolved model makes every answer unknown', async () => {
  const body = envelope({ answers: completeAnswers() });
  delete body.result.model;
  const out = await clef({ ...spec, apiToken: 'token', fetchImpl: async () => response(body) });
  assert.equal(out.resolvedModel, null);
  assert.equal(out.modelMatchesRequest, false);
  assert.equal(out.answers.urgent.status, 'unknown');
  assert.equal(out.answers.urgent.reason, 'resolved_model_mismatch');
});

test('score answers must preserve the requested legend and match the probability-weighted level', async () => {
  const wrongLegend = completeAnswers();
  wrongLegend.severity.legend[1] = 'Critical';
  const legendResult = await clef({ ...spec, apiToken: 'token', fetchImpl: async () => response(envelope({ answers: wrongLegend })) });
  assert.equal(legendResult.answers.severity.status, 'unknown');
  assert.equal(legendResult.answers.severity.reason, 'invalid_legend');

  const inconsistentScore = completeAnswers();
  inconsistentScore.severity.score = 1.1;
  const scoreResult = await clef({ ...spec, apiToken: 'token', fetchImpl: async () => response(envelope({ answers: inconsistentScore })) });
  assert.equal(scoreResult.answers.severity.status, 'unknown');
  assert.equal(scoreResult.answers.severity.reason, 'score_distribution_mismatch');
});

test('failed envelope and errors containing credentials never expose the response body', async () => {
  const secret = 'token-that-must-not-leak';
  await assert.rejects(
    clef({ ...spec, apiToken: secret, fetchImpl: async () => response({ success: false, errors: [{ message: `echo ${secret}` }] }) }),
    (error) => !error.message.includes(secret) && /unsuccessful or malformed/.test(error.message),
  );
  await assert.rejects(
    clef({ ...spec, apiToken: secret, fetchImpl: async () => response({ error: `echo ${secret}` }, { ok: false, status: 403 }) }),
    (error) => !error.message.includes(secret) && error.message.includes('HTTP 403'),
  );
});

test('timeout remains active while the response body is being read', async () => {
  await assert.rejects(clef({
    ...spec,
    apiToken: 'token',
    timeoutMs: 15,
    fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
  }), /timed out after 15 ms/);
});

test('supports lazy token loading and budget preflight at published rates', async () => {
  let reads = 0;
  const out = await clef({
    ...spec,
    model: 'clef-flash',
    readToken: async () => { reads++; return 'token'; },
    fetchImpl: async () => response(envelope({ model: 'clef-flash', answers: completeAnswers(), usage: { prompt_tokens: 2_866 } })),
  });
  assert.equal(reads, 1);
  assert.equal(out.usage.inputTokens, 2866);
  assert.equal(out.cost.inputUsd, 0.00025794);
  assert.equal(clefInputCostUsd('clef', { input_tokens: 1_000_000, output_tokens: 100 }), 0.24);
  assert.equal(assertClefBudget({ model: 'clef', limitUsd: 20, maxRequests: 2 }).reserveUsd, 0.03145728);
  assert.throws(() => assertClefBudget({ model: 'clef-flash', limitUsd: 0.001 }), /Clef budget refused/);
});
