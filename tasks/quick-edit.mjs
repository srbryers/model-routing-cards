/**
 * Quick edit: a small, well-scoped change to one file.
 *
 * Policy (routing-profile.md): Muse Spark is the default builder. GPT-6 Luna
 * is here because the benchmark evidence names it the quick-edit pick on cost
 * (references/best-models-per-work-type.md). This card tests whether the cheap
 * model holds up on a change with one easy-to-miss requirement.
 *
 * The easy-to-miss requirement is the alias: callers still passing `retries`
 * must keep working. Code checks every behaviour and counts the lines changed;
 * Jev reads whether a stranger could tell the alias is deprecated.
 *
 * ⚠ SPEED IS NOT IN THE SCORE. Receipts record `ms`, but the card weighs only
 * metrics. For quick edits latency matters; read it from the receipts.
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

const CONFIG = `/** HTTP client settings, merged over defaults. */
export const DEFAULTS = Object.freeze({
  baseUrl: 'https://api.example.com',
  timeoutMs: 5000,
  retries: 2,
});

export function settings(overrides = {}) {
  const s = { ...DEFAULTS, ...overrides };
  if (!Number.isInteger(s.retries) || s.retries < 0) {
    throw new Error('retries must be a non-negative integer');
  }
  return s;
}

export function attemptsFor(s) {
  return s.retries + 1;
}

export function describe(s) {
  return \`\${s.baseUrl} (timeout \${s.timeoutMs}ms, \${s.retries} retries)\`;
}
`;

const EDIT = `
Rename the \`retries\` setting to \`maxRetries\` throughout config.mjs, and change
the default timeout to 8000 ms. Callers that still pass \`retries\` must keep
working: use it as \`maxRetries\` when \`maxRetries\` is not given. Change nothing else.
`;

/* Behaviour the edit must not touch. */
const UNTOUCHED = {
  base_url_kept: `assert.equal(m.DEFAULTS.baseUrl, 'https://api.example.com');`,
  rejects_negative: `assert.throws(() => m.settings({ maxRetries: -1 }));`,
  rejects_fraction: `assert.throws(() => m.settings({ maxRetries: 1.5 }));`,
  describe_text_kept: `assert.equal(m.describe(m.settings()), 'https://api.example.com (timeout 8000ms, 2 retries)');`,
  defaults_frozen: `assert.ok(Object.isFrozen(m.DEFAULTS));`,
};

/* The edit itself. */
const EDITED = {
  default_timeout: `assert.equal(m.DEFAULTS.timeoutMs, 8000);`,
  renamed_default: `assert.equal(m.DEFAULTS.maxRetries, 2); assert.equal(m.DEFAULTS.retries, undefined);`,
  new_name_works: `assert.equal(m.settings({ maxRetries: 5 }).maxRetries, 5);`,
  attempts_use_new_name: `assert.equal(m.attemptsFor(m.settings({ maxRetries: 4 })), 5);`,
  alias_works: `assert.equal(m.settings({ retries: 4 }).maxRetries, 4);`,
  new_name_wins_over_alias: `assert.equal(m.settings({ retries: 4, maxRetries: 1 }).maxRetries, 1);`,
  alias_is_validated: `assert.throws(() => m.settings({ retries: -3 }));`,
};

/** The reference edit below changes 16 lines (measured with changedLines). */
const TARGET_CHANGED_LINES = 16;

/** The code half of the score. Exported so the gates can be tested offline. */
export function check(output, input) {
  const blocks = fences(output).filter((f) => ['js', 'javascript', 'mjs', ''].includes(f.lang));
  const code = blocks.length === 1 ? blocks[0].body : null;
  if (code === null) {
    return { gates: { one_file_returned: false }, metrics: {}, raw: { fences: blocks.length } };
  }
  if (!parses(code, 'config.mjs')) {
    return { gates: { one_file_returned: true, parses: false }, metrics: {}, raw: {} };
  }
  const kept = runCases('config.mjs', code, UNTOUCHED);
  const done = runCases('config.mjs', code, EDITED);
  const changed = changedLines(input.file, code);
  return {
    gates: {
      one_file_returned: true,
      parses: true,
      no_regression: kept.failed.length === 0,
    },
    metrics: {
      correctness: done.passed.length / Object.keys(EDITED).length,
      /* Closeness to a tidy edit, not "fewer is better": an edit that changes
         two lines has missed something, as surely as one that rewrites forty. */
      tight_scope: closeness(changed, TARGET_CHANGED_LINES, 20),
    },
    raw: { changed_lines: changed, regression_failed: kept.failed, edit_failed: done.failed },
    code,
  };
}

export const task = {
  id: 'quick-edit',
  models: [MODELS.spark, MODELS.luna],
  runs: 3,
  calibration: UNCALIBRATED,
  input: { file: CONFIG, edit: EDIT },

  prompt: (input) =>
    brief({
      role: 'you make one small, well-scoped edit to an existing file.',
      goal: input.edit,
      background:
        'config.mjs holds the settings for an HTTP client. Several services import it, ' +
        'and some of them still pass `retries`; they will migrate later. Tests exist but are not shown to you.',
      files: { 'config.mjs': input.file },
      constraints: [
        'Keep the text describe() returns exactly as it is, apart from the values.',
        'Keep DEFAULTS frozen.',
        'Change nothing the edit does not need.',
      ],
      deliverable:
        'The complete new contents of config.mjs in exactly one ```js fenced block. Nothing else.',
    }),

  score: async (output, input) => {
    const facts = check(output, input);
    return withJudge(facts, () =>
      judge({
        state: { the_edit_requested: input.edit, file_before: input.file, file_after: facts.code },
        metrics: {
          alias_is_clear: {
            instructions:
              'Whether someone reading only `file_after` can tell that `retries` is an old name ' +
              'kept for compatibility and that `maxRetries` is the one to use.',
            levels: [
              'Nothing in the file says `retries` is still accepted, or it reads as a second, equal setting',
              'The fallback is in the code but a reader has to work out why it is there',
              'A short comment or name makes clear `retries` is a deprecated alias for `maxRetries`',
            ],
          },
        },
      }),
    );
  },

  weights: { correctness: 0.5, tight_scope: 0.3, alias_is_clear: 0.2 },
};

const GOOD_CODE = `/** HTTP client settings, merged over defaults. */
export const DEFAULTS = Object.freeze({
  baseUrl: 'https://api.example.com',
  timeoutMs: 8000,
  maxRetries: 2,
});

export function settings(overrides = {}) {
  /* \`retries\` is the old name, still accepted until callers migrate. */
  const { retries, ...rest } = overrides;
  const s = { ...DEFAULTS, ...(retries !== undefined ? { maxRetries: retries } : {}), ...rest };
  if (!Number.isInteger(s.maxRetries) || s.maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative integer');
  }
  return s;
}

export function attemptsFor(s) {
  return s.maxRetries + 1;
}

export function describe(s) {
  return \`\${s.baseUrl} (timeout \${s.timeoutMs}ms, \${s.maxRetries} retries)\`;
}
`;

/* Known outputs, for testing the code gates and, later, calibrating the judge. */
export const examples = {
  good: ['```js\n' + GOOD_CODE + '```'],
  bad: [
    /* Renamed, but dropped the alias: old callers silently get the default. */
    '```js\n' + CONFIG.replaceAll('retries', 'maxRetries').replace('5000', '8000').replace('${s.maxRetries} maxRetries', '${s.maxRetries} retries') + '```',
    /* Two answers, so no single file to take. */
    '```js\n' + GOOD_CODE + '```\nOr, more simply:\n```js\n' + GOOD_CODE + '```',
  ],
};
