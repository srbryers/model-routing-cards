/**
 * Receipts from the runs actually made on 2026-09-12 in the wedding repo, so the
 * trust gate can be exercised on real numbers rather than invented ones.
 *
 * ⚠ These are transcribed from measured bake-off output, not re-derived. The
 * metrics are the ones that harness printed: photo density against the design's
 * 35% target, side-by-side structure, and leaf ratio.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const runs = resolve(process.cwd(), 'runs', 'block-composition');
mkdirSync(runs, { recursive: true });

/* photos = (sections with a photo)/(sections); sbs = row+grid; leaves/blocks. */
const measured = [
  // gemini, after the mustHit fix — 4 of 8 sections, twice, identically
  { model: 'google/gemini-3.8-flash', run: 1, cost: 0.0203, ms: 2129, sections: 8, photos: 4, sbs: 0, blocks: 27, leaves: 19 },
  { model: 'google/gemini-3.8-flash', run: 2, cost: 0.0171, ms: 1881, sections: 8, photos: 4, sbs: 0, blocks: 37, leaves: 26 },
  { model: 'google/gemini-3.8-flash', run: 3, cost: 0.0284, ms: 2094, sections: 8, photos: 4, sbs: 0, blocks: 28, leaves: 20 },
  // gpt-5.5 — put everything under ONE root child, so the density denominator degenerates
  { model: 'openai/gpt-5.5', run: 1, cost: 0.1699, ms: 381, sections: 1, photos: 1, sbs: 0, blocks: 49, leaves: 35 },
  { model: 'openai/gpt-5.5', run: 2, cost: 0.1423, ms: 328, sections: 1, photos: 1, sbs: 0, blocks: 48, leaves: 34 },
  { model: 'openai/gpt-5.5', run: 3, cost: 0.1233, ms: 517, sections: 4, photos: 1, sbs: 0, blocks: 75, leaves: 52 },
];

for (const m of measured) {
  const density = m.sections ? m.photos / m.sections : 0;
  writeFileSync(
    resolve(runs, `${m.model.replace(/\//g, '_')}-${m.run}.json`),
    JSON.stringify(
      {
        task: 'block-composition',
        model: m.model,
        run: m.run,
        at: '2026-09-12',
        state: 'completed',
        ms: m.ms,
        cost_usd: m.cost,
        gates: { parses: true, has_content: m.leaves > 0, non_trivial: m.blocks >= 8 },
        gates_passed: true,
        metrics: {
          photo_density: +(1 - Math.min(1, Math.abs(density - 0.35) / 0.35)).toFixed(4),
          structure: +Math.min(1, m.sbs / 3).toFixed(4),
          substance: +(m.leaves / m.blocks).toFixed(4),
        },
      },
      null,
      2,
    ) + '\n',
  );
}
console.log(`seeded ${measured.length} measured receipts into ${runs}`);
