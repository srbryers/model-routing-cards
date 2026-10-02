/**
 * Code review of a diff with four planted defects.
 *
 * Policy (routing-profile.md): review candidates may be swapped or coin-flipped
 * so comparison evidence accumulates. This card is where that evidence lands.
 * The three candidates here are a draft: Opus 5.5 and Sonnet 5.5 from the
 * profile's own models, and DeepSeek V4 Pro because it had the best measured
 * recall on real PRs (44.2%, Kodus, Aug 2026 — see
 * references/best-models-per-work-type.md).
 *
 * ⚠⚠ RECALL IS COUNTED IN CODE; FALSE ALARMS ARE JUDGED BY JEV. A finding is
 * anchored by an exact quote from the diff, so "did it find the injection" is a
 * substring match. Whether an unplanted finding is a real problem or noise has
 * to be read, so that is Jev's. Jev does not count findings.
 */
import { judge } from '../scripts/jev.mjs';
import { MODELS, UNCALIBRATED, brief, withJudge } from './_harness.mjs';

const DIFF = `diff --git a/routes/orders.mjs b/routes/orders.mjs
--- a/routes/orders.mjs
+++ b/routes/orders.mjs
@@ -1,22 +1,34 @@
 import { db } from '../db.mjs';
 import { audit } from '../audit.mjs';
+import { sendReceipt } from '../email.mjs';

 const PAGE_SIZE = 20;

 export async function listOrders(req) {
   const page = Number(req.query.page ?? 1);
+  const status = req.query.status;
+  const where = status ? \`AND status = '\${status}'\` : '';
   const rows = await db.query(
-    'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
-    [req.user.id, PAGE_SIZE, (page - 1) * PAGE_SIZE],
+    \`SELECT * FROM orders WHERE customer_id = $1 \${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3\`,
+    [req.user.id, PAGE_SIZE, page * PAGE_SIZE],
   );
-  return { orders: rows };
+  return { orders: rows, page };
 }

 export async function createOrder(req) {
   const order = await db.insert('orders', { customer_id: req.user.id, items: req.body.items });
   await audit('order.created', order.id);
+  sendReceipt(req.user.email, order);
   return { order };
 }
+
+export async function cancelOrder(req) {
+  const order = await db.get('orders', req.params.id);
+  if (order.status === 'shipped') throw new Error('already shipped');
+  await db.update('orders', order.id, { status: 'cancelled' });
+  return { order: { ...order, status: 'cancelled' } };
+}
`;

/**
 * The planted defects. `anchors` are substrings; a finding whose quote contains
 * any of them is about that defect. Shown to the judge, never to the model.
 */
const PLANTED = [
  {
    id: 'sql_injection',
    defect: 'req.query.status is interpolated into the SQL string, so a crafted status injects SQL.',
    anchors: ["AND status = '${status}'", '${where}'],
  },
  {
    id: 'pagination_off_by_one',
    defect: 'OFFSET changed from (page - 1) * PAGE_SIZE to page * PAGE_SIZE; page 1 now skips the first 20 orders.',
    anchors: ['page * PAGE_SIZE'],
  },
  {
    id: 'missing_await',
    defect: 'sendReceipt is not awaited or caught; a failed email becomes an unhandled rejection.',
    anchors: ['sendReceipt(req.user.email, order)'],
  },
  {
    id: 'no_ownership_check',
    defect: 'cancelOrder never checks the order belongs to req.user, so any user can cancel any order.',
    anchors: ["db.get('orders', req.params.id)", "db.update('orders', order.id"],
  },
];

const SEVERITIES = ['high', 'medium', 'low'];

/** Diff lines without their +/-/space marker, for checking quotes. */
const strip = (line) => line.replace(/^[+\- ]/, '').trim();
const DIFF_LINES = DIFF.split('\n').filter((l) => !/^(diff |--- |\+\+\+ |@@)/.test(l)).map(strip);

/** The code half of the score. Exported so the gates can be tested offline. */
export function check(output) {
  let obj;
  try {
    const fenced = String(output).match(/```(?:json)?\s*([\s\S]*?)```/);
    obj = JSON.parse(fenced ? fenced[1] : output);
  } catch {
    return { gates: { parses: false }, metrics: {}, raw: {} };
  }
  const findings = Array.isArray(obj?.findings) ? obj.findings : null;
  const wellFormed =
    findings !== null &&
    findings.every(
      (f) =>
        SEVERITIES.includes(f?.severity) &&
        typeof f.quote === 'string' && f.quote.trim() &&
        typeof f.problem === 'string' && f.problem.trim(),
    );
  if (!wellFormed) {
    return { gates: { parses: true, well_formed: false }, metrics: {}, raw: {} };
  }

  /* ⚠ A QUOTE THAT IS NOT IN THE DIFF IS A HALLUCINATED LOCATION. One is
     enough to fail: a reviewer who cites code that does not exist sends the
     reader looking for it. */
  const located = findings.map((f) => {
    const q = strip(f.quote);
    return q.length > 0 && DIFF_LINES.some((line) => line.includes(q));
  });
  const found = PLANTED.filter((p) =>
    findings.some((f) => p.anchors.some((a) => f.quote.includes(a))),
  ).map((p) => p.id);

  return {
    gates: {
      parses: true,
      well_formed: true,
      has_findings: findings.length > 0,
      quotes_are_in_diff: located.every(Boolean),
    },
    metrics: {
      /* Score against the target — all four — not a raw count of findings. */
      recall: found.length / PLANTED.length,
    },
    raw: { findings: findings.length, found },
    findings,
  };
}

export const task = {
  id: 'review',
  models: [MODELS.opus, MODELS.sonnet, MODELS.deepseekPro],
  runs: 3,
  calibration: UNCALIBRATED,
  input: { diff: DIFF, planted: PLANTED },

  prompt: (input) =>
    brief({
      role: 'you review one pull request for defects before it merges.',
      goal: 'Review the diff below and report every defect it introduces.',
      background:
        'routes/orders.mjs serves the order endpoints of a multi-tenant web shop. ' +
        '`req.user` is the authenticated customer. `db.query` takes SQL with $n ' +
        'placeholders and a parameter array. Report correctness and security defects, ' +
        'not style. A finding that is not a real defect costs the author time.',
      files: { 'the diff': input.diff },
      constraints: [
        'Only report defects the diff introduces or exposes.',
        '`quote` must be copied exactly from one line of the diff, without the leading + or -.',
        'If you are unsure a finding is real, leave it out.',
      ],
      deliverable:
        'JSON only, no prose and no code fence, in this shape:\n' +
        '{"findings": [{"severity": "high" | "medium" | "low", "quote": "<one line from the diff>", ' +
        '"problem": "<what goes wrong, concretely>", "fix": "<the change>"}]}',
    }),

  score: async (output, input) => {
    const facts = check(output);
    return withJudge(facts, () =>
      judge({
        state: {
          the_diff: input.diff,
          known_defects: input.planted.map((p) => p.defect),
          findings: facts.findings,
        },
        metrics: {
          explains_the_defects: {
            instructions:
              'For findings about the `known_defects`, whether each `problem` describes ' +
              'the actual failure rather than just pointing at the right line.',
            levels: [
              'Findings point at the right lines but describe a different or vague problem',
              'Some findings describe the actual failure; others are vague or about something else',
              'Every finding about a known defect states the concrete failure and a correct fix',
            ],
          },
          no_false_alarms: {
            instructions:
              'Whether the findings that are NOT about `known_defects` are real problems in ' +
              '`the_diff` or noise: style preferences, misreadings, or issues in unchanged code.',
            levels: [
              'Several findings are wrong or are style preferences presented as defects',
              'Mostly real, with one finding that is wrong or is a style preference',
              'Every finding is a real defect or a reasonable risk in the changed code, or there are none beyond the known defects',
            ],
          },
        },
      }),
    );
  },

  weights: { recall: 0.5, explains_the_defects: 0.25, no_false_alarms: 0.25 },
};

/* Known outputs, for testing the code gates and, later, calibrating the judge. */
const finding = (severity, quote, problem, fix) => ({ severity, quote, problem, fix });
export const examples = {
  good: [
    JSON.stringify({
      findings: [
        finding('high', "const where = status ? `AND status = '${status}'` : '';", 'status from the query string is interpolated into SQL: injection.', 'Add status as a $4 parameter.'),
        finding('high', '[req.user.id, PAGE_SIZE, page * PAGE_SIZE],', 'Pages are 1-based, so page 1 now skips the first 20 orders.', 'Restore (page - 1) * PAGE_SIZE.'),
        finding('medium', 'sendReceipt(req.user.email, order);', 'Not awaited; a failed send is an unhandled rejection.', 'await it inside try/catch, or queue it.'),
        finding('high', "const order = await db.get('orders', req.params.id);", 'No check that the order belongs to req.user; any customer can cancel any order.', 'Reject unless order.customer_id === req.user.id.'),
      ],
    }),
  ],
  bad: [
    /* Finds one, and cites a line that is not in the diff. */
    JSON.stringify({
      findings: [
        finding('high', "const where = status ? `AND status = '${status}'` : '';", 'SQL injection.', 'Parameterise.'),
        finding('low', 'const orders = await fetchAll();', 'Unbounded fetch.', 'Paginate.'),
      ],
    }),
    /* Valid and located, but only style. */
    JSON.stringify({
      findings: [finding('low', 'return { orders: rows, page };', 'Prefer naming the field currentPage.', 'Rename.')],
    }),
  ],
};
