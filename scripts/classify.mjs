import { kindsForClassifier } from './policy.mjs';
import { normalizeSystemOneAnswers } from './clef.mjs';
import { JEV_ENDPOINT, assertJevBudget, jevInputCostUsd } from './jev.mjs';
import { readJevKey } from './jev-key.mjs';

/** One bounded classification. Dry calls do not even consult credentials. */
export async function classify({ brief, execute = false, limitUsd = 0.01 }, {
  policy, fetchImpl = globalThis.fetch, readKey = readJevKey, budget = assertJevBudget,
} = {}) {
  if (!execute) return { status: 'needs_kind', reason: 'dry', confidence: null, top: [], costUsd: 0 };
  const criteria = Object.fromEntries(kindsForClassifier(policy).map(({ id, description }) => [id, description]));
  criteria.unknown = 'The brief is unclear, lacks a task, or none of the listed kinds fits.';
  const questions = { kind: { type: 'choice', instructions: 'Which kind best describes this agent task? Choose unknown when the brief is insufficient.', criteria } };
  const body = JSON.stringify({ model: 'jev-latest', state: { brief }, questions });
  // ⚠ Do not truncate a task into a different task, or read a key before budget approval.
  const bytes = Buffer.byteLength(body);
  if (bytes > 80_000) throw new TypeError('Classifier request exceeds 80000 bytes; shorten the brief or pass --kind');
  budget({ limitUsd, maxRequests: 1, maxInputTokens: bytes });
  const key = readKey();
  let response;
  try {
    response = await fetchImpl(JEV_ENDPOINT, { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(30_000) });
  } catch {
    // ⚠ Errors can echo credentials or the brief; retain only a fixed failure reason.
    return { status: 'needs_kind', reason: 'classifier_unavailable', confidence: null, top: [], costUsd: null };
  }
  if (!response.ok) return { status: 'needs_kind', reason: 'classifier_http_error', confidence: null, top: [], costUsd: null };
  let result;
  try { result = await response.json(); }
  catch { return { status: 'needs_kind', reason: 'classifier_invalid_json', confidence: null, top: [], costUsd: null }; }
  const answer = normalizeSystemOneAnswers(questions, result?.answers).kind;
  const ranked = Object.entries(answer.distribution ?? {}).map(([kind, p]) => ({ kind, p }))
    .sort((a, b) => b.p - a.p || a.kind.localeCompare(b.kind));
  const top = ranked.filter(item => item.kind !== 'unknown').slice(0, 3);
  const costUsd = Number.isInteger(result?.usage?.input_tokens) && result.usage.input_tokens >= 0
    ? jevInputCostUsd(result.usage) : null;
  const reason = answer.status === 'unknown' || answer.selected === 'unknown' ? 'unknown'
    : ranked[0].p < policy.classifier.minProbability ? 'low_probability'
      : ranked[0].p - ranked[1].p < policy.classifier.minMargin ? 'small_margin' : null;
  return { status: reason ? 'needs_kind' : 'ok', ...(reason ? { reason } : { kind: answer.selected }),
    confidence: answer.confidence, top, costUsd };
}
