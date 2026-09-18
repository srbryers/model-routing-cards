/**
 * The trust gate, as a pure function.
 *
 * ⚠⚠ EXTRACTED SO IT CAN BE TESTED. It began inline in `route.mjs`, which meant
 * the one piece of logic that decides whether to believe a measurement was the
 * one piece with no test. Everything here takes receipts and returns a card; it
 * reads no files, makes no requests and knows nothing about OpenRouter.
 */

export const TRUST = {
  /** Below this many completed runs per model, no preference is expressed. */
  MIN_RUNS: 3,
  /** A model failing gates more often than this is out, whatever it scores. */
  MAX_GATE_FAIL: 0.34,
  /**
   * ⚠ If the top two models' run ranges OVERLAP there is no winner, only a
   * cheaper one. Reporting a mean difference smaller than the spread is how a
   * benchmark launders variance into a decision.
   */
  REQUIRE_SEPARATION: true,
  /**
   * ⚠⚠ A ROUTING CARD EXPIRES; A REGRESSION BENCHMARK DOES NOT. Fathoms freezes
   * its ten prompts on purpose — to compare pipeline versions a moving target is
   * useless. Routing is the opposite question: lineups change monthly, so a card
   * that cannot go stale keeps recommending a model that was retired. Same
   * machinery, opposite lifetime.
   */
  STALE_DAYS: 30,
};

/** Weighted score for one run. With no weights, the plain mean of its metrics. */
export function weigh(metrics, weights) {
  const keys = Object.keys(weights ?? {});
  if (!keys.length) {
    const vals = Object.values(metrics ?? {});
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return keys.reduce((n, k) => n + (metrics?.[k] ?? 0) * weights[k], 0);
}

export function summarise(receipts, weights) {
  const byModel = new Map();
  for (const r of receipts) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }

  const rows = [];
  for (const [model, rs] of byModel) {
    const done = rs.filter((r) => r.state === 'completed');
    const passed = done.filter((r) => r.gates_passed);
    const scores = passed.map((r) => weigh(r.metrics, weights));
    const costs = done.map((r) => r.cost_usd).filter((c) => typeof c === 'number');
    const total = costs.reduce((a, b) => a + b, 0);
    rows.push({
      model,
      runs: rs.length,
      completed: done.length,
      gate_fail_rate: done.length ? 1 - passed.length / done.length : 1,
      score_mean: scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4) : 0,
      score_min: scores.length ? +Math.min(...scores).toFixed(4) : null,
      score_max: scores.length ? +Math.max(...scores).toFixed(4) : null,
      cost_mean_usd: costs.length ? +(total / costs.length).toFixed(4) : null,
      /**
       * ⚠⚠ COST PER ACCEPTED RESULT, NOT PER CALL. A model that is cheap and
       * fails its gates half the time is not cheap — you paid for the rejects
       * too. The divisor is ACCEPTED runs while the numerator is ALL spend,
       * which is the whole point; dividing by `done` would hide the waste.
       */
      cost_per_accepted_usd: costs.length && passed.length ? +(total / passed.length).toFixed(4) : null,
      /**
       * ⚠⚠ HOW THE COST WAS KNOWN, NOT JUST WHAT IT WAS. A subscription call
       * reports no per-token price; recording that as 0 would make it look free
       * beside a metered model and a card would then recommend the "cheapest"
       * on a number nobody measured.
       */
      cost_source: done.find((r) => r.cost_source)?.cost_source ?? (costs.length ? 'reported' : 'unknown'),
    });
  }
  rows.sort((a, b) => b.score_mean - a.score_mean);
  return rows;
}

export function buildCard(receipts, { taskId, weights, trust = TRUST, today } = {}) {
  const rows = summarise(receipts, weights);
  const notes = [];

  const eligible = rows.filter((r) => {
    if (r.completed < trust.MIN_RUNS) {
      notes.push(`${r.model}: only ${r.completed} completed runs (${trust.MIN_RUNS} required)`);
      return false;
    }
    if (r.gate_fail_rate > trust.MAX_GATE_FAIL) {
      notes.push(
        `${r.model}: fails gates ${Math.round(r.gate_fail_rate * 100)}% of runs — disqualified`,
      );
      return false;
    }
    return true;
  });

  let status = 'CALIBRATED';
  let recommend = null;
  let why = '';

  if (eligible.length === 0) {
    status = 'UNCALIBRATED';
    why = 'no model has enough clean runs to compare';
  } else if (eligible.length === 1) {
    recommend = eligible[0].model;
    status = 'SINGLE_CANDIDATE';
    why = 'only one model cleared the gates — this is not a comparison';
  } else {
    const [a, b] = eligible;
    const separated = a.score_min > b.score_max;
    if (trust.REQUIRE_SEPARATION && !separated) {
      status = 'NO_CLEAR_WINNER';
      const overlap =
        `run ranges overlap (${a.model} ${a.score_min}-${a.score_max} vs ` +
        `${b.model} ${b.score_min}-${b.score_max})`;
      /**
       * ⚠⚠ MIXED COST SOURCES CANNOT BE TIE-BROKEN ON COST. One model billed per
       * token and one covered by a subscription are not cheaper and dearer than
       * each other — they are different kinds of expensive, and picking the
       * "cheaper" would be comparing a measured number with an absent one. When
       * quality cannot separate them either, the honest card recommends NOTHING
       * and says both facts.
       */
      const comparable = a.cost_source === b.cost_source && a.cost_per_accepted_usd !== null;
      if (!comparable) {
        recommend = null;
        why =
          `${overlap}, and costs are not comparable ` +
          `(${a.model}: ${a.cost_source}, ${b.model}: ${b.cost_source}) — no basis to choose`;
      } else {
        const cheaper = [a, b]
          .slice()
          .sort(
            (x, y) => (x.cost_per_accepted_usd ?? Infinity) - (y.cost_per_accepted_usd ?? Infinity),
          )[0];
        recommend = cheaper.model;
        why = `${overlap}; recommending the cheaper per accepted result`;
      }
    } else {
      recommend = a.model;
      why = `${a.model} scores above ${b.model} with no overlap across runs`;
    }
  }

  return {
    task: taskId,
    generated: (today ?? new Date()).toISOString().slice(0, 10),
    expires_days: trust.STALE_DAYS,
    trust: status,
    recommend,
    why,
    notes,
    weights: Object.keys(weights ?? {}).length ? weights : 'unweighted mean of metrics',
    models: rows,
  };
}

/** Has this card outlived the lineup it was measured against? */
export function isStale(card, today = new Date()) {
  const days = (today - new Date(card.generated)) / 86_400_000;
  return days > (card.expires_days ?? TRUST.STALE_DAYS);
}
