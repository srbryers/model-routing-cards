#!/usr/bin/env node
/**
 * Installed entry point: `model-routing run|card <task.mjs> [flags]`.
 *
 * ⚠ A thin wrapper, not a second implementation. `run` and `card` spawn the
 * same `scripts/route.mjs` with the same args and inherit its stdio and exit
 * code, so the installed CLI cannot drift from `node scripts/route.mjs`.
 * Later PRs add `pick` and `record` as one entry each in COMMANDS.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(here, '..', 'scripts', 'route.mjs');
const VERSION = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8')).version;

const USAGE = `usage: model-routing <command> [args]

  run <task.mjs> [flags]    execute the bake-off, write receipts (dry by default)
  card <task.mjs> [flags]   aggregate receipts into a routing card

pick and record are coming in a later release.

run and card behave exactly like \`node scripts/route.mjs run|card ...\`.
Receipts and cards are written beside the task file, never inside the install.
`;

/* ⚠ One entry per command: a later PR adds `pick` / `record` here and nowhere
   else. Each entry receives the args after the command name. */
const COMMANDS = {
  run: (args) => execRoute(['run', ...args]),
  card: (args) => execRoute(['card', ...args]),
};

function execRoute(args) {
  const r = spawnSync(process.execPath, [ROUTE, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (argv[0] === '--version') {
  console.log(VERSION);
  process.exit(0);
}

const cmd = COMMANDS[argv[0]];
if (!cmd) {
  process.stderr.write(USAGE);
  process.exit(2);
}

cmd(argv.slice(1));
