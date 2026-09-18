#!/usr/bin/env node
/**
 * A routing card: which model for this task, and whether to believe it.
 *
 * ⚠⚠ THIS IS NOT AN EVAL PLATFORM AND MUST NOT GROW INTO ONE. Braintrust,
 * Promptfoo, DeepEval and TrueFoundry already do production evaluation, tracing,
 * online scoring and gateway routing, and they do it better than a local script
 * will. They all route LIVE TRAFFIC. This answers a different question: an agent
 * working in a repo needs to hand a sub-task to a worker model, on this machine,
 * now — and needs to know whether that choice rests on anything.
 *
 * The deliverable is a small JSON artifact a skill can read, with a trust status
 * attached. If the evidence is thin the card SAYS SO and declines to prefer a
 * model, which is the behaviour every leaderboard gets wrong.
 *
 *   route.mjs run  <task.mjs>    # execute the bake-off, write receipts
 *   route.mjs card <task.mjs>    # aggregate receipts into a routing card
 *
 * A project supplies the task; this supplies the discipline. See
 * references/task-interface.md.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/* ⚠ ONE IMPLEMENTATION OF THE TRUST GATE, and it is the tested one. It started
   inline in this file, which made the single piece of logic that decides whether
   to believe a measurement the single piece with no test. */
import { buildCard, TRUST } from './card.mjs';
import { call, parseModel, keyNames, keyNameFor } from './providers.mjs';

const CATALOG = 'https://openrouter.ai/api/v1/models';

const argv = process.argv.slice(2);
const cmd = argv[0];
const taskPath = argv[1] ? resolve(argv[1]) : null;
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(`--${n}`);

function devVar(name, dir) {
  /* ⚠ The script reads the key itself, so the value never passes through a
     conversation, a log line or a process argument.
     ⚠ It WALKS UP from the task file: tasks live in subdirectories, and one
     `.env` at a repo root should serve all of them rather than being copied
     beside each task — a secret duplicated per directory is a secret that gets
     committed from the one nobody remembered to ignore. */
  let here = dir;
  for (let i = 0; i < 6; i += 1) {
    for (const f of ['.dev.vars', '.env']) {
      const p = resolve(here, f);
      if (!existsSync(p)) continue;
      /* ⚠⚠ THE LAST ASSIGNMENT WINS, AND `String.match` GIVES YOU THE FIRST. A
         shell sourcing the file, and every dotenv, take the last assignment of a
         repeated key. A first-wins read disagrees with them, and the script is
         the one that is wrong. Measured in the wedding repo: `.env` carried
         `ADMIN_PASSWORD` twice, the empty one first, so a first-wins read
         returned '' and the run reported the key ABSENT while the shell had the
         value the whole time. It cost an afternoon and two wrong diagnoses. */
      const found = [...readFileSync(p, 'utf8').matchAll(new RegExp(`^${name}=(.*)$`, 'gm'))]
        .map((m) => m[1].replace(/^"(.*)"$/, '$1').trim())
        .filter(Boolean);
      if (found.length) return found[found.length - 1];
    }
    const up = dirname(here);
    if (up === here) break;
    here = up;
  }
  if (process.env[name]) return process.env[name];
  throw new Error(`${name} not found in .dev.vars/.env near ${dir}, or the environment`);
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

if (!cmd || !taskPath) {
  console.error('usage: route.mjs run|card <task.mjs> [--runs N] [--execute]');
  process.exit(1);
}

const task = (await import(pathToFileURL(taskPath).href)).task;
for (const k of ['id', 'models', 'prompt', 'score']) {
  if (!task?.[k]) throw new Error(`task is missing "${k}" — see references/task-interface.md`);
}
const taskDir = dirname(taskPath);
const runsDir = resolve(taskDir, 'runs', task.id);
mkdirSync(runsDir, { recursive: true });

/* ── run ───────────────────────────────────────────────────────────────── */

if (cmd === 'run') {
  const N = Number(flag('runs', task.runs ?? TRUST.MIN_RUNS));
  const specs = task.models.map(parseModel);

  console.log(`task      ${task.id}`);
  for (const sp of specs) console.log(`          ${sp.provider.padEnd(11)} ${sp.model}`);
  console.log(`runs      ${N} each\n`);

  /**
   * ⚠⚠ THE CREDENTIAL IS READ AFTER THIS CHECK, NOT BEFORE.
   *
   * The first version called `devVar` at the top of `run`, so a dry run failed
   * with "OPENROUTER_API_KEY not found" on a machine that had no key — which is
   * precisely the machine where a dry run is most useful, and it defeated the
   * property SKILL.md advertises. Dry means dry: no credential, no catalog
   * fetch, no request.
   */
  if (!has('execute')) {
    const p = task.prompt(task.input);
    console.log(`prompt    ${Math.round(p.length / 1024)}KB, sha ${sha(p)}`);
    console.log(`\n--execute to spend. No credential was read and nothing was sent.`);
    process.exit(0);
  }

  /* ⚠ Only fetch a key for providers that need one, and ONE PER PROVIDER. A
     task running entirely on a subscription must not demand an OpenRouter key it
     will never use — and a card spanning two gateways needs both, because
     handing one provider's credential to another reads as a bad key rather than
     the wrong key. */
  const keys = Object.fromEntries(
    keyNames(specs).map((name) => [name, devVar(name, taskDir)]),
  );
  /* Only OpenRouter has a catalog to check against. */
  const openrouterKey = keys.OPENROUTER_API_KEY ?? null;

  if (openrouterKey) {
    const catalog = await fetch(CATALOG).then((r) => r.json());
    const priced = new Set(catalog.data.map((m) => m.id));
    for (const sp of specs) {
      if (sp.provider === 'openrouter' && !priced.has(sp.model)) {
        throw new Error(`${sp.model} is not in the OpenRouter catalog`);
      }
    }
  }

  for (const spec of specs) {
    for (let i = 1; i <= N; i += 1) {
      const safe = spec.label.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const file = resolve(runsDir, `${safe}-${i}.json`);
      if (existsSync(file) && !has('force')) {
        console.log(`  . ${spec.label} run ${i} - already recorded`);
        continue;
      }
      const prompt = task.prompt(task.input);
      const t0 = Date.now();
      const receipt = {
        task: task.id,
        model: spec.label,
        provider: spec.provider,
        run: i,
        at: new Date().toISOString(),
        prompt_sha256: sha(prompt),
        state: 'sent',
      };
      try {
        const res = await call(spec, {
          prompt,
          schema: task.schema,
          /* ⚠ THE KEY FOR THIS SPEC'S PROVIDER, not "the" key. Handing one
             provider's credential to another reads as a bad key, not the
             wrong key. */
          key: keys[keyNameFor(spec.provider)] ?? null,
        });
        receipt.ms = Date.now() - t0;
        Object.assign(receipt, res);
        if (res.state === 'completed') {
          receipt.output_sha256 = sha(res.text);
          /* ⚠ AWAITED, so a project can score with something that has to ask.
             A scorer counting brackets stays synchronous and `await` costs it
             nothing; a scorer that reads the output — `scripts/jev.mjs` — has to
             make a call, and without this its promise was written into the
             receipt as `gates: {}` and every gate passed vacuously. */
          const scored = await task.score(res.text, task.input);
          receipt.gates = scored.gates ?? {};
          receipt.metrics = scored.metrics ?? {};
          /* Kept when the scorer offers it: the probabilities behind a
             judgement, so a surprising receipt can be read without re-running
             the model that produced it. */
          if (scored.raw) receipt.judged = scored.raw;
          receipt.gates_passed = Object.values(receipt.gates).every(Boolean);
          /* ⚠ The response text is NOT kept in the receipt — receipts are read
             by tooling and a full model answer in every one of them makes the
             ledger unreadable. The hash is the identity; re-run to see it. */
          delete receipt.text;
        }
      } catch (err) {
        receipt.state = 'threw';
        receipt.error = String(err).slice(0, 160);
        receipt.ms = receipt.ms ?? Date.now() - t0;
      }
      writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
      const tick = receipt.state === 'completed' ? (receipt.gates_passed ? 'ok ' : 'gate') : 'FAIL';
      const money =
        receipt.cost_source === 'subscription'
          ? 'subscription'
          : typeof receipt.cost_usd === 'number'
            ? '$' + receipt.cost_usd.toFixed(4)
            : '-';
      console.log(
        `  ${tick} ${spec.label} run ${i}  ${receipt.ms}ms  ${money}` +
          `${receipt.state !== 'completed' ? '  ' + receipt.state + (receipt.status ? ' ' + receipt.status : '') : ''}`,
      );
    }
  }
  console.log(`\nreceipts in ${runsDir}`);
  console.log(`next: route.mjs card ${basename(taskPath)}`);
}

/* ── card ──────────────────────────────────────────────────────────────── */

if (cmd === 'card') {
  const receipts = readdirSync(runsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(runsDir, f), 'utf8')));

  if (!receipts.length) {
    console.error(`no receipts for ${task.id} — run it first`);
    process.exit(1);
  }

  const card = buildCard(receipts, {
    taskId: task.id,
    weights: task.weights ?? {},
  });
  const rows = card.models;
  const { trust: status, recommend, why, notes } = card;

  const out = resolve(taskDir, 'runs', `${task.id}.card.json`);
  writeFileSync(out, JSON.stringify(card, null, 2) + '\n');

  console.log(`\n=== routing card — ${task.id} ===`);
  console.log(`trust      ${status}`);
  console.log(`recommend  ${recommend ?? '(none — evidence too thin)'}`);
  console.log(`why        ${why}`);
  if (notes.length) for (const n of notes) console.log(`  ⚠ ${n}`);
  console.log('');
  console.log(
    'model                            ok/run  gatefail  score (min–max)         $/accepted',
  );
  console.log('─'.repeat(86));
  for (const r of rows) {
    const range = `${r.score_mean} (${r.score_min}–${r.score_max})`;
    console.log(
      /* ⚠ COMPLETED OVER ATTEMPTED, not one number. A bare "0" beside "100%
         gatefail" reads as a model that answered badly; it actually never
         answered at all, and those are different facts about a model. */
      `${r.model.padEnd(32)}${(r.completed + '/' + r.runs).padStart(6)}  ` +
        `${String(Math.round(r.gate_fail_rate * 100) + '%').padStart(8)}  ` +
        `${range.padEnd(26)}` +
        `${r.cost_per_accepted_usd !== null ? '$' + r.cost_per_accepted_usd : '—'}`,
    );
  }
  console.log(`\n  ${out}`);
  console.log(
    '\n⚠ A card is evidence for a decision, not the decision. It expires in ' +
      `${TRUST.STALE_DAYS} days because model lineups change; a regression benchmark would not.`,
  );
}
