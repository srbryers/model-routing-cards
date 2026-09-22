/**
 * Scoring with a System One model.
 *
 * `score` is the one thing this tool refuses to supply — only the project knows
 * what good looks like for its task. What the project has always had to supply
 * *as code*, though, is the hard part: counting brackets is easy, judging
 * whether a page reads like the house voice is not. So the hand-written scorers
 * measure what can be counted, and `references/task-interface.md` carries the
 * scar:
 *
 *   "Told to put half its sections side by side, a model returned eight grids,
 *    sixteen columns, and not one heading, paragraph or image inside them.
 *    Measured as `row + grid: 8` that reads as a success."
 *
 * A judgement model closes that gap. Jev's three primitives land exactly on the
 * task interface's two fields — a Noul is a gate, a Score is a metric — so this
 * is a shape change, not a new concept.
 *
 * ⚠⚠ JEV FOR JUDGEMENT, CODE FOR FACTS, AND THE SPLIT IS NOT A STYLE CHOICE.
 * Every question asked here adds the judge's OWN variance to a measurement whose
 * whole point is variance. Measured on a different task the same week: the same
 * sweep, five runs, found what it was looking for 3/3 every time and threw 0 to
 * 2 FALSE POSITIVES depending on the run. A substring check in code removed them
 * completely. So put `parses`, `non_empty`, `kept_the_shape` and anything a
 * regex can settle in plain JS, and spend questions only on what needs reading.
 *
 * ⚠ A JUDGE NEEDS ITS OWN CALIBRATION. `checkJudge` below exists because a
 * scorer nobody has tested against known-good and known-bad output is a number
 * generator. Run it before trusting a card built on these numbers.
 *
 * ⚠ ONE REQUEST. Independent questions over the same state run in parallel, so
 * every gate and metric for one output costs a single call (~400ms, fractions of
 * a cent). Jev's request limit is 32k tokens; `state` is truncated toward it
 * rather than silently overflowing.
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/**
 * Published Jev 1.13 price and request ceiling, checked 2026-09-22.
 * Output tokens are free. Keep the source beside the number so a caller never
 * mistakes an old constant for current billing authority.
 */
export const JEV_PRICING = Object.freeze({
  inputUsdPerMillion: 0.042,
  maxInputTokensPerRequest: 64_000,
  source: 'https://docs.typesafe.ai/models',
  verifiedOn: '2026-09-22',
});

export function jevInputCostUsd(usage = {}) {
  const inputTokens = Number(usage.input_tokens ?? 0);
  if (!Number.isFinite(inputTokens) || inputTokens < 0) {
    throw new Error('Jev usage.input_tokens must be a non-negative number');
  }
  return Number(((inputTokens / 1_000_000) * JEV_PRICING.inputUsdPerMillion).toFixed(12));
}

/**
 * Refuse a paid batch unless even its documented worst case fits the caller's
 * remaining authorization. Actual spend is calculated from response usage.
 */
export function assertJevBudget({ limitUsd, spentUsd = 0, maxRequests = 1 }) {
  for (const [name, value] of Object.entries({ limitUsd, spentUsd, maxRequests })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  }
  if (!Number.isInteger(maxRequests)) throw new Error('maxRequests must be an integer');

  const reserveUsd = Number((
    maxRequests * JEV_PRICING.maxInputTokensPerRequest / 1_000_000
      * JEV_PRICING.inputUsdPerMillion
  ).toFixed(12));
  const remainingUsd = Number((limitUsd - spentUsd).toFixed(12));
  if (reserveUsd > remainingUsd) {
    throw new Error(
      `Jev budget refused: ${maxRequests} request(s) can cost up to $${reserveUsd.toFixed(6)}, ` +
        `but only $${Math.max(0, remainingUsd).toFixed(6)} remains`,
    );
  }
  return { limitUsd, spentUsd, remainingUsd, reserveUsd, maxRequests };
}

/** Jev's per-request ceiling, with room for the questions. */
const MAX_STATE_CHARS = 80_000;

/**
 * A Noul answers a probability; a gate answers yes or no.
 *
 * ⚠ 0.5 IS A DEFAULT, NOT A FINDING. The right threshold is the one measured on
 * your task and your consequences — and a gate is the expensive direction to be
 * wrong in, because a failed gate throws the whole run away. Raise it when a
 * false failure costs more than a false pass.
 */
const GATE_THRESHOLD = 0.5;

function readKey() {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    throw new Error(
      'TYPESAFE_API_KEY is not set. Jev scoring needs a TypeSafe key; ' +
        'see https://docs.typesafe.ai. Scoring in plain JS needs no key at all.',
    );
  }
  return key;
}

/** Keep the newest of a long state rather than the oldest — outputs end with
 *  the part a judge most needs. */
function fit(state) {
  const text = typeof state === 'string' ? state : JSON.stringify(state);
  if (text.length <= MAX_STATE_CHARS) return text;
  const keep = MAX_STATE_CHARS - 40;
  return `[… ${text.length - keep} chars omitted …]\n${text.slice(-keep)}`;
}

/**
 * Ask one request's worth of gates and metrics about one output.
 *
 * @param {object} spec
 * @param {object|string} spec.state   what the judge needs to see
 * @param {Record<string,string>} [spec.gates]
 *        name → the condition, phrased so that YES means the run is usable
 * @param {Record<string,{instructions:string,levels:string[]}>} [spec.metrics]
 *        name → an ordered ladder, worst first. Levels must describe concrete
 *        situations and stand on their own; "medium" is not a level.
 * @param {number} [spec.threshold]
 * @returns {Promise<{model:string|null,gates:object,metrics:object,raw:object,usage:object,cost:object}>}
 *          Shaped for `task.score`, with `raw` kept so a receipt can be audited
 *          without re-running anything.
 */
export async function judge({ state, gates = {}, metrics = {}, threshold = GATE_THRESHOLD }) {
  const questions = {};
  for (const [name, condition] of Object.entries(gates)) {
    questions[`gate_${name}`] = { type: 'noul', instructions: condition };
  }
  for (const [name, m] of Object.entries(metrics)) {
    if (!Array.isArray(m.levels) || m.levels.length < 2) {
      throw new Error(`metric "${name}" needs at least two ordered levels`);
    }
    questions[`metric_${name}`] = {
      type: 'score',
      instructions: m.instructions,
      criteria: m.levels,
    };
  }
  if (Object.keys(questions).length === 0) {
    throw new Error('judge() was given no gates and no metrics');
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${readKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'jev-latest', state: fit(state), questions }),
  });
  if (!res.ok) {
    /* ⚠ The status, not the body: an error body can echo the request, and the
       request carries the key. */
    throw new Error(`TypeSafe answered ${res.status}`);
  }
  const body = await res.json();

  const usage = body.usage ?? {};
  const out = {
    model: typeof body.model === 'string' ? body.model : null,
    gates: {},
    metrics: {},
    raw: {},
    usage,
    cost: {
      inputUsd: jevInputCostUsd(usage),
      inputUsdPerMillion: JEV_PRICING.inputUsdPerMillion,
      source: JEV_PRICING.source,
      verifiedOn: JEV_PRICING.verifiedOn,
    },
  };
  for (const [id, answer] of Object.entries(body.answers ?? {})) {
    if (id.startsWith('gate_')) {
      const name = id.slice(5);
      out.gates[name] = answer.noul >= threshold;
      out.raw[name] = answer.noul;
    } else if (id.startsWith('metric_')) {
      const name = id.slice(7);
      /* A Score sits on 0..levels-1; the interface wants 0..1. */
      const top = Object.keys(answer.legend ?? {}).length - 1;
      out.metrics[name] = top > 0 ? Number((answer.score / top).toFixed(4)) : 0;
      out.raw[name] = { score: answer.score, confidence: answer.confidence };
    }
  }
  return out;
}

/**
 * Does this judge separate output you already know is good from output you know
 * is bad?
 *
 * ⚠⚠ RUN THIS BEFORE BELIEVING A CARD BUILT ON JEV SCORES. A judge that rates
 * everything 0.7 produces a card whose ranges overlap for a reason that has
 * nothing to do with the models being compared — and the trust gate will
 * faithfully report NO_CLEAR_WINNER about the judge's indifference.
 *
 * Pass outputs you are certain about. The check is deliberately crude: every
 * known-good must outscore every known-bad. A judge that cannot manage that on
 * examples you chose will not manage it on examples you did not.
 *
 * @param {object} spec  the same shape `judge` takes, minus `state`
 * @param {(output:unknown)=>object|string} spec.stateFor
 * @param {unknown[]} spec.good
 * @param {unknown[]} spec.bad
 */
export async function checkJudge({ stateFor, good, bad, gates, metrics, threshold }) {
  const run = async (output) => {
    const r = await judge({ state: stateFor(output), gates, metrics, threshold });
    const values = Object.values(r.metrics);
    return {
      mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
      gatesPassed: Object.values(r.gates).every(Boolean),
      detail: r,
    };
  };

  const goods = await Promise.all(good.map(run));
  const bads = await Promise.all(bad.map(run));

  const worstGood = Math.min(...goods.map((g) => g.mean));
  const bestBad = Math.max(...bads.map((b) => b.mean));

  return {
    separates: worstGood > bestBad,
    worstGood: Number(worstGood.toFixed(4)),
    bestBad: Number(bestBad.toFixed(4)),
    margin: Number((worstGood - bestBad).toFixed(4)),
    /* A judge whose gates pass everything is not gating. */
    gatesRejectedBad: bads.filter((b) => !b.gatesPassed).length,
    goods,
    bads,
  };
}
