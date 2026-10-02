/**
 * Bug fix: diagnose and fix a reported bug from a symptom, not a stack trace.
 *
 * Policy (routing-profile.md): Sonnet 5.5 and GPT-6 Luna are the bug-fix
 * candidates. Recovery after repeated failures goes to Opus 5.5 and is a
 * different job; this card measures the first attempt.
 *
 * The bug: an LRU cache whose `get` does not refresh recency, reported as "hot
 * sessions get evicted". Code checks that the repro now passes, that nothing
 * else broke, and that `peek` still does NOT refresh recency — the over-eager
 * fix. Jev reads only the diagnosis: did the model name the real cause.
 */
import { judge } from '../scripts/jev.mjs';
import {
  MODELS,
  UNCALIBRATED,
  brief,
  fences,
  parses,
  runCases,
  changedLines,
  closeness,
  withJudge,
} from './_harness.mjs';

const CACHE = `/**
 * A least-recently-used cache for session objects. Map keeps insertion order,
 * so the first key is always the least recently used.
 */
export class LruCache {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer');
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    return this.map.get(key);
  }

  /** Read without touching recency, for metrics and debugging. */
  peek(key) {
    return this.map.get(key);
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  get size() {
    return this.map.size;
  }
}
`;

const REPORT = `
Title: Hot sessions get evicted from the session cache

Under load, sessions that are read on every request get evicted while idle
sessions stay in the cache. Users with active sessions are being logged out.

Repro:
  const c = new LruCache(2);
  c.set('a', 1); c.set('b', 2);
  c.get('a');            // 'a' is now the most recently used
  c.set('c', 3);         // should evict 'b'
  c.get('a')  -> undefined   (expected 1)
  c.get('b')  -> 2           (expected undefined)
`;

/** What the bug actually is. Shown to the judge, never to the model. */
const KNOWN_CAUSE =
  '`get` returns the value without moving the key to the most-recent end of the Map, ' +
  'so reading an entry does not count as using it and eviction removes it first.';

const REGRESSION = {
  set_evicts_oldest: `
    const c = new m.LruCache(2); c.set('a', 1); c.set('b', 2); c.set('c', 3);
    assert.equal(c.peek('a'), undefined); assert.equal(c.size, 2);`,
  set_refreshes_existing: `
    const c = new m.LruCache(2); c.set('a', 1); c.set('b', 2); c.set('a', 9); c.set('c', 3);
    assert.equal(c.peek('a'), 9); assert.equal(c.peek('b'), undefined);`,
  rejects_bad_capacity: `assert.throws(() => new m.LruCache(0));`,
  /* ⚠ THE OVER-EAGER FIX. Making every read refresh recency fixes the report
     and breaks the documented contract of peek. */
  peek_does_not_refresh: `
    const c = new m.LruCache(2); c.set('a', 1); c.set('b', 2); c.peek('a'); c.set('c', 3);
    assert.equal(c.peek('a'), undefined); assert.equal(c.peek('b'), 2);`,
};

const REPRO = {
  get_refreshes_recency: `
    const c = new m.LruCache(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
    assert.equal(c.get('a'), 1); assert.equal(c.get('b'), undefined);`,
};

const EDGES = {
  missing_get_does_not_insert: `
    const c = new m.LruCache(2); c.set('a', 1); assert.equal(c.get('zz'), undefined); assert.equal(c.size, 1);`,
  falsy_value_refreshes: `
    const c = new m.LruCache(2); c.set('a', 0); c.set('b', 2); assert.equal(c.get('a'), 0); c.set('c', 3);
    assert.equal(c.peek('a'), 0); assert.equal(c.peek('b'), undefined);`,
  undefined_value_kept: `
    const c = new m.LruCache(2); c.set('a', undefined); assert.equal(c.size, 1); c.get('a'); assert.equal(c.size, 1);`,
};

/** A good fix rewrites `get` and nothing else: about six lines. */
const TARGET_CHANGED_LINES = 6;

/** The code half of the score. Exported so the gates can be tested offline. */
export function check(output, input) {
  const blocks = fences(output).filter((f) => ['js', 'javascript', 'mjs', ''].includes(f.lang));
  const code = blocks.length === 1 ? blocks[0].body : null;
  const cause = String(output).match(/root cause:\s*([\s\S]*?)(?:```|$)/i)?.[1]?.trim() ?? '';
  if (code === null) {
    return { gates: { one_file_returned: false }, metrics: {}, raw: { fences: blocks.length } };
  }
  if (!parses(code, 'lru.mjs')) {
    return { gates: { one_file_returned: true, parses: false }, metrics: {}, raw: {} };
  }
  const repro = runCases('lru.mjs', code, REPRO);
  const reg = runCases('lru.mjs', code, REGRESSION);
  const edge = runCases('lru.mjs', code, EDGES);
  const changed = changedLines(input.file, code);
  return {
    gates: {
      one_file_returned: true,
      parses: true,
      gave_a_root_cause: cause.length > 0,
      bug_fixed: repro.failed.length === 0,
      no_regression: reg.failed.length === 0,
    },
    metrics: {
      edge_cases: edge.passed.length / Object.keys(EDGES).length,
      minimal_change: closeness(changed, TARGET_CHANGED_LINES, 30),
    },
    raw: {
      changed_lines: changed,
      regression_failed: reg.failed,
      edge_failed: edge.failed,
    },
    cause,
  };
}

export const task = {
  id: 'bug-fix',
  models: [MODELS.sonnet, MODELS.luna],
  runs: 3,
  calibration: UNCALIBRATED,
  input: { file: CACHE, report: REPORT, knownCause: KNOWN_CAUSE },

  prompt: (input) =>
    brief({
      role: 'you diagnose and fix one reported bug in an existing JavaScript codebase.',
      goal: 'Find the root cause of the bug in this report and fix it.\n' + input.report,
      background:
        'lru.mjs is the session cache for a web service. Other code relies on every ' +
        'method in it, including peek. Tests exist but are not shown to you.',
      files: { 'lru.mjs': input.file },
      constraints: [
        'Fix the cause, not the symptom in the repro.',
        'Keep the documented behaviour of every other method.',
        'Change as little as the fix needs. No unrelated refactors.',
      ],
      deliverable:
        'First a line starting "Root cause:" followed by one short paragraph. Then the ' +
        'complete fixed contents of lru.mjs in exactly one ```js fenced block. Nothing after the block.',
    }),

  score: async (output, input) => {
    const facts = check(output, input);
    return withJudge(facts, () =>
      judge({
        state: { bug_report: input.report, actual_cause: input.knownCause, cause_given: facts.cause },
        gates: {
          names_the_real_cause:
            '`cause_given` identifies the same defect as `actual_cause`. Answer no if it ' +
            'describes only the symptom, blames eviction or capacity, or names a different defect.',
        },
        metrics: {
          diagnosis_quality: {
            instructions:
              'How well `cause_given` would let another engineer understand the bug without reading the code.',
            levels: [
              'It restates the symptom from `bug_report` with no mechanism',
              'It names the right method but not why that causes the eviction',
              'It names the method, the missing recency update and how that leads to the wrong eviction',
            ],
          },
        },
      }),
    );
  },

  weights: { edge_cases: 0.35, minimal_change: 0.25, diagnosis_quality: 0.4 },
};

const GOOD_CODE = CACHE.replace(
  '  get(key) {\n    return this.map.get(key);\n  }',
  `  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }`,
);

/* Known outputs, for testing the code gates and, later, calibrating the judge. */
export const examples = {
  good: [
    'Root cause: get() reads from the Map without re-inserting the key, so a read never ' +
      'moves the entry to the most-recent end and set() evicts it as if it were idle.\n\n' +
      '```js\n' + GOOD_CODE + '```',
  ],
  bad: [
    /* The over-eager fix: peek refreshes too. Fails the regression gate. */
    'Root cause: reads do not refresh recency.\n\n```js\n' +
      GOOD_CODE.replace(
        '  peek(key) {\n    return this.map.get(key);\n  }',
        '  peek(key) {\n    return this.get(key);\n  }',
      ) + '```',
    /* Truthiness check: fixes the repro, drops falsy values. Passes gates, loses edge cases. */
    'Root cause: capacity is too small.\n\n```js\n' +
      CACHE.replace(
        '  get(key) {\n    return this.map.get(key);\n  }',
        `  get(key) {
    const value = this.map.get(key);
    if (!value) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }`,
      ) + '```',
  ],
};
