#!/usr/bin/env node
/**
 * Does the real Jev classifier sort known briefs into the kinds we expect?
 *
 * ⚠ The kind descriptions in policy/policy.json are the only thing Jev reads. A
 * wording change can move a brief into another tier, so run this after editing them.
 * Offline tests only cover the plumbing; this is the live check.
 *
 *   node scripts/classify.check.mjs               # dry: lists the briefs, no key, no calls
 *   node scripts/classify.check.mjs --execute     # one paid Jev call per brief, capped at $0.05
 *
 * A case passes only when the classifier would have routed it: status ok, and the
 * kind is one of the expected kinds. A low-probability or small-margin answer fails.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from './policy.mjs';
import { classify } from './classify.mjs';
import { assertJevBudget } from './jev.mjs';

export const CAP_USD = 0.05;

/** Each brief is a plain task description; `expect` lists every kind that is a correct answer. */
export const CASES = [
  { brief: 'Add regression tests for pick\'s quota handling across scripts/pick.test.mjs and bin tests: both soft thresholds triggering at once, the alternative pool unavailable, and an escalated tier-1 task followed by a normal tier-2 pick read back through the CLI decision log. Fix any bug the tests expose in scripts/pick.mjs or scripts/state.mjs. Run npm test and open a PR.',
    expect: ['hard-bug-fix', 'multi-step-coding'] },
  { brief: 'Add unit tests for the existing parseDuration helper in utils/time.ts. Do not change any product code.',
    expect: ['write-tests'] },
  { brief: 'Rename the function getUser to fetchUser everywhere in src/ and fix the lint errors that causes.',
    expect: ['quick-edit'] },
  { brief: 'Update the README install section and add a changelog entry for version 0.4.0.',
    expect: ['docs'] },
  { brief: 'Find where session tokens are refreshed in this repo and explain how it works. Do not change anything.',
    expect: ['scouting'] },
  { brief: 'The login button throws "undefined is not a function" on click. Here is the stack trace and a one-line repro. Fix it.',
    expect: ['simple-bug-fix'] },
  { brief: 'The server crashes about once a day in production. We have no repro and no stack trace. Find the cause and fix it.',
    expect: ['hard-bug-fix'] },
  { brief: 'Move the whole app from Webpack to Vite: update the configs, imports and CI.',
    expect: ['migration'] },
  { brief: 'Our GitHub Actions build fails with "pnpm: command not found" on the runner. Fix the pipeline.',
    expect: ['ci-terminal'] },
  { brief: 'Design the data contract for the new orders API: request and response schemas and how we version them.',
    expect: ['data-contract'] },
  { brief: 'Decide how to split the monolith into services: where the boundaries go, queues or direct calls, and the trade-offs.',
    expect: ['architecture'] },
  { brief: 'Rewrite the welcome message and the error text our users see in the app so they sound friendly.',
    expect: ['user-facing-copy'] },
  { brief: 'Review this diff for security problems before it merges to the production branch.',
    expect: ['high-risk-review'] },
  // Ambiguous on purpose: each sits between two kinds, and the descriptions must break the tie.
  { brief: 'The checkout page crashes every time a coupon is applied. It reproduces every time, but we do not know why. Find the cause and fix it.',
    expect: ['hard-bug-fix'] },
  { brief: 'The retry loop stops one attempt early: it uses i < max where the repro shows it needs i <= max. Change that one line.',
    expect: ['simple-bug-fix'] },
  { brief: 'Add unit tests for the settings screen view model in our iOS app. Tests only, no app code changes.',
    expect: ['ios'] },
  { brief: 'Move the billing module from React Router 5 to React Router 7: update its routes, hooks and imports.',
    expect: ['migration'] },
];

/** Exact request size per brief, measured without a key or a network call. */
async function requestBytes(brief, policy) {
  let bytes = 0;
  await classify({ brief, execute: true, limitUsd: CAP_USD }, { policy, budget: () => {}, readKey: () => 'unused',
    fetchImpl: async (_, request) => { bytes = Buffer.byteLength(request.body); return { ok: false }; } });
  return bytes;
}

export async function runCheck({ cases = CASES, execute = false, policy = loadPolicy(), classifyImpl = classify,
  budget = assertJevBudget, write = text => process.stdout.write(text) } = {}) {
  if (!execute) {
    write(`dry: ${cases.length} briefs; pass --execute to classify them (one Jev call each, cap $${CAP_USD})\n`);
    return { executed: false, rows: [], passed: 0, failed: 0, spentUsd: 0 };
  }
  // ⚠ Preflight the whole run before any key is read: worst case is every request's full input.
  const sizes = await Promise.all(cases.map(({ brief }) => requestBytes(brief, policy)));
  const reserve = budget({ limitUsd: CAP_USD, maxRequests: 1, maxInputTokens: sizes.reduce((a, b) => a + b, 0) });
  write(`budget ok: ${cases.length} requests reserve up to $${reserve.reserveUsd.toFixed(6)} of $${CAP_USD}\n`);
  const rows = [];
  let spentUsd = 0;
  for (const { brief, expect } of cases) {
    // A request whose cost is unknown is charged at its full reserve, so the cap still holds.
    const answer = await classifyImpl({ brief, execute: true, limitUsd: CAP_USD - spentUsd }, { policy });
    spentUsd += answer.costUsd ?? CAP_USD / cases.length;
    const top = answer.top[0];
    const got = answer.status === 'ok' ? answer.kind : `${top?.kind ?? 'none'} (${answer.reason})`;
    rows.push({ expect, got, p: top?.p ?? null, pass: answer.status === 'ok' && expect.includes(answer.kind), brief });
  }
  const passed = rows.filter(r => r.pass).length;
  const cell = (text, width) => String(text).padEnd(width);
  write(`\n${cell('expected', 36)}${cell('got', 38)}${cell('p', 7)}result\n`);
  for (const r of rows) {
    write(`${cell(r.expect.join(' | '), 36)}${cell(r.got, 38)}${cell(r.p === null ? '-' : r.p.toFixed(2), 7)}${r.pass ? 'pass' : 'FAIL'}\n`);
  }
  write(`\n${passed}/${rows.length} passed; spent about $${spentUsd.toFixed(6)} of $${CAP_USD}\n`);
  return { executed: true, rows, passed, failed: rows.length - passed, spentUsd };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCheck({ execute: process.argv.includes('--execute') });
  process.exitCode = result.failed ? 1 : 0;
}
