/**
 * Example task — the project-supplied half of a routing card.
 *
 * The tool owns running, budgeting, receipts, aggregation and the trust gate.
 * The PROJECT owns two things it is the only one able to answer: what the task
 * is, and what counts as good. That split is what makes the tool portable —
 * a benchmark is never portable, but the discipline around one is.
 *
 * This example is the wedding project's block-tree composition task, which is
 * where the pattern came from. Its scorer is the interesting part: the design
 * hands the composer numeric targets, so "did it do well" has a measurable
 * answer instead of a judgement.
 */
export const task = {
  id: 'block-composition',

  models: ['google/gemini-3.8-flash', 'openai/gpt-5.5'],
  runs: 3,

  input: { brief: 'a page about getting from Madrid to Toledo for wedding guests' },

  prompt: (input) => `Compose a page: ${input.brief}`,

  /**
   * ⚠⚠ GATES BEFORE METRICS, AND A GATE FAILURE IS NOT A LOW SCORE. Fathoms'
   * evaluator short-circuits to 0.0 on a failed hard gate rather than averaging
   * it away, because a mesh that will not import has no aesthetics worth
   * measuring. The same holds here: a tree whose props do not survive the save
   * has not composed a page, however good it looks.
   */
  score: (output) => {
    let tree;
    try {
      tree = JSON.parse(output);
    } catch {
      return { gates: { parses: false }, metrics: {} };
    }
    const root = tree.root ?? tree.tree?.root ?? [];
    let blocks = 0;
    let leaves = 0;
    let sideBySide = 0;
    let withPhoto = 0;
    const walk = (ns) => {
      for (const n of ns ?? []) {
        blocks += 1;
        if (['row', 'grid'].includes(n.type)) sideBySide += 1;
        if (!['row', 'column', 'grid', 'cover'].includes(n.type)) leaves += 1;
        walk(n.children);
      }
    };
    walk(root);
    for (const s of root) {
      let found = false;
      const w = (ns) => {
        for (const n of ns ?? []) {
          if (n.type === 'image' || n.props?.image) found = true;
          w(n.children);
        }
      };
      w([s]);
      if (found) withPhoto += 1;
    }

    return {
      gates: {
        parses: true,
        /* ⚠ THE EMPTY-SKELETON GATE. Told to put sections side by side, a model
           returned eight grids, sixteen columns and not one heading, paragraph
           or image inside them — and "row + grid: 8" read as a success. Every
           structural measure needs a content measure beside it. */
        has_content: leaves > 0,
        non_trivial: blocks >= 8,
      },
      metrics: {
        /* Closeness to the design's 35% photo-density target, not raw count. */
        photo_density: 1 - Math.min(1, Math.abs((root.length ? withPhoto / root.length : 0) - 0.35) / 0.35),
        /* The live site runs 5 rows on /schedule; the composer has managed 0. */
        structure: Math.min(1, sideBySide / 3),
        /* Leaves per block — a page that is mostly containers is mostly nothing. */
        substance: blocks ? leaves / blocks : 0,
      },
    };
  },

  /** ⚠ Locked, like Fathoms' evaluator weights. Changing these re-dates the card. */
  weights: { photo_density: 0.4, structure: 0.35, substance: 0.25 },
};
