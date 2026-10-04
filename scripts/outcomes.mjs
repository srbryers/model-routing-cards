/** ⚠ Different tasks went to different routes. Field outcomes can justify a
 * bake-off, but are confounded and must never become trust-gate receipts. */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readDecisions, withStateLock } from './state.mjs';
import { JEV_ENDPOINT, assertJevBudget, fitJevState, jevInputCostUsd } from './jev.mjs';
import { readJevKey } from './jev-key.mjs';

export const FIELD_LABEL = 'field outcomes — not a comparison';
const RESULTS = ['pass', 'partial', 'fail', 'abandoned'];

export function validateGates(gates) {
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)
    || Object.entries(gates).some(([name, value]) => !/^[a-zA-Z0-9_.-]+$/.test(name) || !['pass', 'fail'].includes(value))) {
    throw new TypeError('Gates must be an object of name: "pass" or "fail" facts from code');
  }
  return gates;
}

async function checkBrief(brief, result, limitUsd, {
  budget = assertJevBudget, readKey = readJevKey, fetchImpl = globalThis.fetch,
}) {
  // ⚠ Approve the worst-case cost before reading a credential or sending text.
  budget({ limitUsd, maxRequests: 1 });
  let body;
  try {
    const response = await fetchImpl(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state: fitJevState({ brief, result }),
        questions: { metBrief: { type: 'noul', instructions: 'Does the result meet the brief?' } } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('http');
    body = await response.json();
  } catch {
    // ⚠ Request errors can echo private text or keys. Never forward their bodies.
    throw new Error('Jev brief check failed; no outcome recorded');
  }
  const probability = body?.answers?.metBrief?.noul;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('Jev returned an invalid probability; no outcome recorded');
  }
  return { metBrief: probability, model: typeof body.model === 'string' ? body.model : null,
    costUsd: Number.isSafeInteger(body?.usage?.input_tokens) && body.usage.input_tokens >= 0
      ? jevInputCostUsd(body.usage) : null };
}

export async function recordOutcome({ decisionId, result, gates = {}, failuresBefore = 0,
  notes = '', execute = false, briefFile, resultFile, limitUsd = 0.01 }, {
  stateDir, now = new Date(), readFile = readFileSync, ...jevDeps
}) {
  if (!RESULTS.includes(result)) throw new TypeError('--result must be pass, fail, partial or abandoned');
  validateGates(gates);
  if (!Number.isSafeInteger(failuresBefore) || failuresBefore < 0) throw new TypeError('--failures-before must be a nonnegative integer');
  if (typeof notes !== 'string' || [...notes].length > 500) throw new TypeError('--notes must be at most 500 characters');
  if (!Number.isFinite(limitUsd) || limitUsd < 0) throw new TypeError('--jev-limit-usd must be a nonnegative number');
  if (execute && (!briefFile || !resultFile)) throw new TypeError('--execute requires --brief-file and --result-file');
  const decision = await withStateLock(stateDir, () => readDecisions(stateDir).find(d => d.id === decisionId));
  if (!decision) throw new TypeError(`Unknown decision id: ${decisionId}`);
  if (!decision.kind || !decision.route || !decision.basis) throw new TypeError('Decision did not select a route');
  let jev;
  if (execute) {
    const brief = readFile(briefFile, 'utf8');
    if (createHash('sha256').update(brief).digest('hex') !== decision.brief?.sha256) {
      throw new TypeError('Brief hash does not match the decision; no outcome recorded');
    }
    // ⚠ No state lock during a network request: other picks and records can proceed.
    jev = await checkBrief(brief, readFile(resultFile, 'utf8'), limitUsd, jevDeps);
  }
  const record = { decisionId, at: new Date(now).toISOString(), kind: decision.kind,
    route: decision.route, basis: decision.basis, repo: decision.repo ?? null,
    result, gates, failuresBefore, ...(jev ? { jev } : {}), notes };
  await withStateLock(stateDir, () => {
    appendFileSync(join(stateDir, 'outcomes.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  });
  return record;
}

export function readOutcomes(dir) {
  let text;
  try { text = readFileSync(join(dir, 'outcomes.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.split('\n').filter(Boolean).map(JSON.parse);
}

const basisCounts = () => ({ trial: 0, policy: 0, card: 0, 'card-cheaper': 0 });

export function summarizeOutcomes(decisions, outcomes, policy, kind) {
  // ⚠ Append order, not caller timestamps, defines the latest correction.
  const latest = new Map(outcomes.map(outcome => [outcome.decisionId, outcome]));
  const grouped = new Map();
  for (const decision of new Map(decisions.map(d => [d.id, d])).values()) {
    if (!decision.route || (kind && decision.kind !== kind)) continue;
    const key = `${decision.kind}/${decision.route}`;
    if (!grouped.has(key)) grouped.set(key, { kind: decision.kind, route: decision.route,
      decisions: 0, recordedOutcomes: 0, pass: 0, partial: 0, fail: 0, abandoned: 0,
      decisionBasis: basisCounts(), outcomeBasis: basisCounts() });
    const row = grouped.get(key);
    row.decisions++;
    row.decisionBasis[decision.basis]++;
    const outcome = latest.get(decision.id);
    if (outcome) {
      row.recordedOutcomes++;
      row[outcome.result]++;
      row.outcomeBasis[decision.basis]++;
    }
  }
  const rows = [...grouped.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.route.localeCompare(b.route));
  const { minRoutes, minOutcomesPerRoute } = policy.fieldEvidence;
  const kinds = kind ? [kind] : [...new Set(decisions.map(d => d.kind).filter(Boolean))].sort();
  const readiness = kinds.map(kind => {
    const qualifiedRoutes = rows.filter(row => row.kind === kind && row.recordedOutcomes >= minOutcomesPerRoute).map(row => row.route);
    const ready = qualifiedRoutes.length >= minRoutes;
    const card = policy.cards.byKind[kind] ?? null;
    const task = card ? card.replace('tasks/runs/', 'tasks/').replace(/\.card\.json$/, '.mjs') : `tasks/${kind}.mjs`;
    return { kind, ready, qualifiedRoutes, card, task,
      nextStep: ready ? `Write or extend ${task} for ${kind}; ${card ? `check cards.byKind["${kind}"] maps to ${card}` : `map cards.byKind["${kind}"] to tasks/runs/${kind}.card.json`}; then run model-routing run ${task} --execute` : null };
  });
  return { label: FIELD_LABEL, thresholds: { minOutcomesPerRoute, minRoutes }, rows, readiness };
}

export function formatOutcomes(summary) {
  const headers = ['kind', 'route', 'decisions', 'recorded', 'pass', 'partial', 'fail', 'abandoned', 'decision basis T/P/C/CC', 'outcome basis T/P/C/CC'];
  const split = counts => [counts.trial, counts.policy, counts.card, counts['card-cheaper']].join('/');
  const table = [headers, ...summary.rows.map(r => [r.kind, r.route, r.decisions, r.recordedOutcomes,
    r.pass, r.partial, r.fail, r.abandoned, split(r.decisionBasis), split(r.outcomeBasis)].map(String))];
  const widths = headers.map((_, i) => Math.max(...table.map(row => row[i].length)));
  return `${summary.label}\n${table.map(row => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()).join('\n')}\n`
    + 'Basis: T=trial, P=policy, C=card, CC=card-cheaper. Different tasks; counts do not establish route quality.\n'
    + (summary.readiness.length ? summary.readiness.map(r => `${r.kind}: ${r.ready ? 'ready for a bake-off' : 'not ready for a bake-off'} — ${r.qualifiedRoutes.length}/${summary.thresholds.minRoutes} routes with at least ${summary.thresholds.minOutcomesPerRoute} outcomes each.${r.nextStep ? `\nNext: ${r.nextStep}` : ''}\n`).join('') : 'No decisions recorded.\n');
}
