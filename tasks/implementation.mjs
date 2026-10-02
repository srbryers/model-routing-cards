/**
 * Feature implementation: add discount codes to a small cart module.
 *
 * Policy (routing-profile.md): Muse Spark is the default builder; Opus 5.5 is
 * reserved for demanding work. This card asks whether ordinary feature work
 * actually needs Opus, which is the question the default rests on.
 *
 * The facts are checked by running the code: the returned file must parse, the
 * existing behaviour must survive, and the new behaviour is tested by cases the
 * model never sees. Jev reads only what tests cannot: does the change fit the
 * codebase, and did it stay inside the brief.
 */
import { judge } from '../scripts/jev.mjs';
import { MODELS, UNCALIBRATED, brief, fences, parses, runCases, withJudge } from './_harness.mjs';

const CART = `/**
 * A shopping cart. Money is integer cents everywhere; nothing here uses floats.
 * Every function returns a new cart and never mutates its argument.
 */

/** @param {{sku: string, unitCents: number, qty: number}} item */
export function lineTotal(item) {
  return item.unitCents * item.qty;
}

export function subtotal(cart) {
  return cart.items.reduce((n, it) => n + lineTotal(it), 0);
}

/** Adding a SKU already in the cart increases its quantity. */
export function addItem(cart, item) {
  if (cart.items.some((it) => it.sku === item.sku)) {
    return {
      ...cart,
      items: cart.items.map((it) => (it.sku === item.sku ? { ...it, qty: it.qty + item.qty } : it)),
    };
  }
  return { ...cart, items: [...cart.items, item] };
}
`;

const FEATURE = `
Add discount codes to cart.mjs. Export three new functions:

- applyDiscount(cart, code) returns a new cart with \`discountCode\` set to the
  code in upper case. Matching is case-insensitive. Applying a code replaces any
  code already applied. An unknown code throws an Error whose message includes
  the code as given.
- discountCents(cart) returns the discount for the cart as it is now, in
  integer cents, or 0 when no code is applied. The discount follows the
  current items, so adding items after applying a code can change it.
- total(cart) returns subtotal minus discountCents.

Codes:
- SAVE10: 10% of the subtotal, rounded down to a whole cent.
- FIVER: 500 cents off, only when the subtotal is at least 2000 cents;
  otherwise the code stays applied and the discount is 0.
`;

/* ⚠ HIDDEN FROM THE MODEL. The brief says the behaviour in words; these check
   it. Regression cases are the module's behaviour before the change. */
const REGRESSION = {
  line_total: `assert.equal(m.lineTotal({ sku: 'a', unitCents: 250, qty: 3 }), 750);`,
  subtotal: `assert.equal(m.subtotal({ items: [{ sku: 'a', unitCents: 250, qty: 2 }, { sku: 'b', unitCents: 99, qty: 1 }] }), 599);`,
  add_merges_sku: `
    const c = m.addItem({ items: [{ sku: 'a', unitCents: 100, qty: 1 }] }, { sku: 'a', unitCents: 100, qty: 2 });
    assert.equal(c.items.length, 1); assert.equal(c.items[0].qty, 3);`,
  add_does_not_mutate: `
    const before = { items: [{ sku: 'a', unitCents: 100, qty: 1 }] };
    m.addItem(before, { sku: 'b', unitCents: 5, qty: 1 });
    assert.equal(before.items.length, 1);`,
};

const cart = (cents) => `{ items: [{ sku: 'x', unitCents: ${cents}, qty: 1 }] }`;
const ACCEPTANCE = {
  save10_rounds_down: `assert.equal(m.discountCents(m.applyDiscount(${cart(1999)}, 'SAVE10')), 199);`,
  save10_total: `assert.equal(m.total(m.applyDiscount(${cart(1000)}, 'SAVE10')), 900);`,
  fiver_below_threshold: `
    const c = m.applyDiscount(${cart(1999)}, 'FIVER');
    assert.equal(c.discountCode, 'FIVER'); assert.equal(m.discountCents(c), 0);`,
  fiver_at_threshold: `assert.equal(m.total(m.applyDiscount(${cart(2000)}, 'FIVER')), 1500);`,
  case_insensitive: `assert.equal(m.applyDiscount(${cart(100)}, 'save10').discountCode, 'SAVE10');`,
  unknown_code_throws: `assert.throws(() => m.applyDiscount(${cart(100)}, 'Bogus9'), /Bogus9/);`,
  replaces_previous: `
    const c = m.applyDiscount(m.applyDiscount(${cart(3000)}, 'SAVE10'), 'FIVER');
    assert.equal(c.discountCode, 'FIVER'); assert.equal(m.total(c), 2500);`,
  follows_later_items: `
    let c = m.applyDiscount(${cart(1500)}, 'FIVER');
    c = m.addItem(c, { sku: 'y', unitCents: 1000, qty: 1 });
    assert.equal(m.discountCents(c), 500);`,
  no_code_no_discount: `const c = ${cart(800)}; assert.equal(m.discountCents(c), 0); assert.equal(m.total(c), 800);`,
  apply_does_not_mutate: `
    const c = ${cart(100)}; m.applyDiscount(c, 'SAVE10');
    assert.equal(c.discountCode, undefined);`,
};

/** The code half of the score. Exported so the gates can be tested offline. */
export function check(output) {
  const blocks = fences(output).filter((f) => ['js', 'javascript', 'mjs', ''].includes(f.lang));
  const code = blocks.length === 1 ? blocks[0].body : null;
  if (code === null) {
    return { gates: { one_file_returned: false }, metrics: {}, raw: { fences: blocks.length } };
  }
  if (!parses(code, 'cart.mjs')) {
    return { gates: { one_file_returned: true, parses: false }, metrics: {}, raw: {} };
  }
  const reg = runCases('cart.mjs', code, REGRESSION);
  const acc = runCases('cart.mjs', code, ACCEPTANCE);
  return {
    gates: {
      one_file_returned: true,
      parses: true,
      /* ⚠ A REGRESSION IS A GATE, NOT A LOW SCORE. A feature that breaks what
         already worked is not a partial success. */
      no_regression: reg.failed.length === 0,
    },
    metrics: {
      acceptance: acc.passed.length / Object.keys(ACCEPTANCE).length,
    },
    raw: { regression_failed: reg.failed, acceptance_failed: acc.failed },
    code,
  };
}

export const task = {
  id: 'implementation',
  models: [MODELS.spark, MODELS.opus],
  runs: 3,
  calibration: UNCALIBRATED,
  input: { file: CART, feature: FEATURE },

  prompt: (input) =>
    brief({
      role: 'you implement one feature in an existing JavaScript codebase.',
      goal: input.feature,
      background:
        'cart.mjs is an ES module used by a checkout service. Other modules import ' +
        'lineTotal, subtotal and addItem, so their names and behaviour must not change. ' +
        'Tests exist but are not shown to you; the goal above is the specification.',
      files: { 'cart.mjs': input.file },
      constraints: [
        'Keep money in integer cents. No floating-point results.',
        'Never mutate an argument; return new objects, as the existing code does.',
        'No new dependencies and no imports.',
        'Do only what the goal asks. No unrelated refactors.',
      ],
      deliverable:
        'The complete new contents of cart.mjs in exactly one ```js fenced block. ' +
        'After the block, at most three sentences on what you changed.',
    }),

  score: async (output, input) => {
    const facts = check(output);
    return withJudge(facts, () =>
      judge({
        state: { the_feature_request: input.feature, file_before: input.file, file_after: facts.code },
        metrics: {
          fits_the_codebase: {
            instructions:
              'Whether the new code in `file_after` reads as if the author of `file_before` wrote it: ' +
              'same idioms, same immutability, same comment style.',
            levels: [
              'The new code ignores the existing idioms: it mutates arguments, uses classes or globals the file never used, or reads as foreign',
              'The new code works in the file but mixes in a different style in places',
              'The new code is indistinguishable in style from the existing code',
            ],
          },
          stays_in_scope: {
            instructions:
              'Whether `file_after` adds what `the_feature_request` asked for and nothing else.',
            levels: [
              'Existing functions were rewritten or features were added that nobody asked for',
              'Small unrequested changes appear alongside the feature, such as renamed variables or reformatted old code',
              'Only the requested feature was added; the existing code is untouched',
            ],
          },
        },
      }),
    );
  },

  weights: { acceptance: 0.6, fits_the_codebase: 0.2, stays_in_scope: 0.2 },
};

/* Known outputs, for testing the code gates and, later, calibrating the judge
   (scripts/jev.check.mjs pattern). */
const GOOD_CODE = `${CART}
const CODES = {
  SAVE10: (sub) => Math.floor(sub / 10),
  FIVER: (sub) => (sub >= 2000 ? 500 : 0),
};

/** Codes match case-insensitively; an unknown code throws. */
export function applyDiscount(cart, code) {
  const key = String(code).toUpperCase();
  if (!CODES[key]) throw new Error(\`unknown discount code: \${code}\`);
  return { ...cart, discountCode: key };
}

/** The discount follows the current items, not the items when it was applied. */
export function discountCents(cart) {
  return cart.discountCode ? CODES[cart.discountCode](subtotal(cart)) : 0;
}

export function total(cart) {
  return subtotal(cart) - discountCents(cart);
}
`;

export const examples = {
  good: ['```js\n' + GOOD_CODE + '```\nAdded applyDiscount, discountCents and total.'],
  bad: [
    /* Floats and a discount frozen at apply time: parses, fails acceptance. */
    '```js\n' +
      CART +
      `
export function applyDiscount(cart, code) {
  const sub = subtotal(cart);
  const c = code.toUpperCase();
  if (c === 'SAVE10') return { ...cart, discountCode: c, frozen: sub * 0.1 };
  if (c === 'FIVER') return { ...cart, discountCode: c, frozen: 500 };
  throw new Error('bad code');
}
export const discountCents = (cart) => cart.frozen ?? 0;
export const total = (cart) => subtotal(cart) - discountCents(cart);
` +
      '```',
    /* Broke an existing export. */
    '```js\n' + GOOD_CODE.replace('export function addItem', 'function addItem') + '```',
  ],
};
