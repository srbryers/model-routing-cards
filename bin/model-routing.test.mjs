/* Offline: no keys, no network. Seeds a temp copy of the example task so the
   worktree gains no files. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const bin = join(here, 'model-routing.mjs');
const route = join(root, 'scripts', 'route.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const run = (file, args, opts = {}) =>
  spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', ...opts });

describe('model-routing CLI', () => {
  it('--version matches package.json', () => {
    const r = run(bin, ['--version']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), pkg.version);
  });

  it('no args prints usage with run and card', () => {
    const r = run(bin, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /run/);
    assert.match(r.stdout, /card/);
    assert.match(r.stdout, /pick \[flags\]/);
  });

  it('unknown command exits 2 with usage on stderr', () => {
    const r = run(bin, ['nope']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/);
  });

  it('card matches route.mjs card on a seeded temp task', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-routing-'));
    const task = join(dir, 'example-task.mjs');
    copyFileSync(join(root, 'example-task.mjs'), task);
    const seed = spawnSync(process.execPath, [join(root, 'seed-from-today.mjs')], {
      encoding: 'utf8',
      cwd: dir,
    });
    assert.equal(seed.status, 0, seed.stderr);

    const viaBin = run(bin, ['card', task]);
    const viaRoute = run(route, ['card', task]);
    assert.equal(viaBin.status, 0, viaBin.stderr);
    assert.equal(viaRoute.status, 0, viaRoute.stderr);
    assert.equal(viaBin.stdout, viaRoute.stdout);
  });
});

// ⚠ npm installs an executable symlink; the import guard must resolve it.
it('installed executable symlink still invokes the CLI', t => {
  const dir = mkdtempSync(join(tmpdir(), 'model-routing-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, 'model-routing');
  symlinkSync(bin, link);
  const result = run(link, ['--version']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), pkg.version);
});

it('card --out writes the generated card to a user data directory', t => {
  const dir = mkdtempSync(join(tmpdir(), 'model-routing-out-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const task = join(dir, 'example-task.mjs');
  copyFileSync(join(root, 'example-task.mjs'), task);
  const seed = run(join(root, 'seed-from-today.mjs'), [], { cwd: dir });
  assert.equal(seed.status, 0, seed.stderr);
  const out = join(dir, 'data', 'model-routing', 'cards');
  const result = run(bin, ['card', task, '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  const card = JSON.parse(readFileSync(join(out, 'block-composition.card.json'), 'utf8'));
  assert.equal(card.task, 'block-composition');
});
