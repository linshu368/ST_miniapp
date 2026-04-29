#!/usr/bin/env node
/**
 * Sync the baseline-runner harness/adapters and case fixtures from this repo
 * into a running SillyTavern install, where they'll be served as
 * /baseline-runner/... when ST is started.
 *
 * Source (canonical):
 *   packages/backend/test/baseline-runner/{harness.js, adapters/}
 *   packages/backend/test/fixtures/<step>/cases/
 *
 * Target (running ST):
 *   <ST_RUNTIME_PATH>/public/baseline-runner/{harness.js, adapters/, fixtures/<step>/cases/}
 *
 * Usage:
 *   node scripts/sync-baseline-runner.mjs                  # sync runner + all detected steps
 *   node scripts/sync-baseline-runner.mjs --step macros    # sync runner + one step's fixtures
 *   node scripts/sync-baseline-runner.mjs --dry-run        # print what would happen
 *   ST_RUNTIME_PATH=/path/to/st node scripts/sync-baseline-runner.mjs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const DEFAULT_RUNTIME_PATH = '/Users/qj/python_project/SillyTavern_runtime';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(HERE, '..');
const RUNNER_SOURCE = path.join(BACKEND_ROOT, 'test/baseline-runner');
const FIXTURES_SOURCE = path.join(BACKEND_ROOT, 'test/fixtures');

function parseArgs(argv) {
  const out = { dryRun: false, step: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--step') out.step = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/sync-baseline-runner.mjs [--step <name>] [--dry-run]

Env:
  ST_RUNTIME_PATH   absolute path to a running SillyTavern install
                    (default: ${DEFAULT_RUNTIME_PATH})
`);
}

function ensureDir(p, dryRun) {
  if (fs.existsSync(p)) return;
  if (dryRun) {
    console.log(`[dry] mkdir -p ${p}`);
    return;
  }
  fs.mkdirSync(p, { recursive: true });
}

function copyTree(src, dst, dryRun) {
  if (!fs.existsSync(src)) {
    throw new Error(`Source missing: ${src}`);
  }
  const stat = fs.statSync(src);
  if (stat.isFile()) {
    ensureDir(path.dirname(dst), dryRun);
    if (dryRun) {
      console.log(`[dry] cp ${rel(src)} -> ${rel(dst)}`);
      return;
    }
    fs.copyFileSync(src, dst);
    return;
  }
  if (stat.isDirectory()) {
    ensureDir(dst, dryRun);
    for (const name of fs.readdirSync(src)) {
      copyTree(path.join(src, name), path.join(dst, name), dryRun);
    }
  }
}

function rel(p) {
  const home = process.env.HOME ?? '';
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function detectSteps(fixturesRoot) {
  if (!fs.existsSync(fixturesRoot)) return [];
  return fs
    .readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(fixturesRoot, name, 'cases', 'index.json')));
}

function main() {
  const args = parseArgs(process.argv);
  const runtimePath = process.env.ST_RUNTIME_PATH || DEFAULT_RUNTIME_PATH;

  if (!fs.existsSync(runtimePath)) {
    console.error(`✗ ST runtime not found at: ${runtimePath}`);
    console.error(`  Set ST_RUNTIME_PATH or clone SillyTavern there:`);
    console.error(`    git clone https://github.com/SillyTavern/SillyTavern.git ${runtimePath}`);
    process.exit(1);
  }

  const runtimePublic = path.join(runtimePath, 'public');
  if (!fs.existsSync(runtimePublic)) {
    console.error(`✗ ${runtimePath} does not look like a SillyTavern install (no public/ folder).`);
    process.exit(1);
  }

  const targetRoot = path.join(runtimePublic, 'baseline-runner');
  console.log(`Source (runner)  : ${rel(RUNNER_SOURCE)}`);
  console.log(`Source (fixtures): ${rel(FIXTURES_SOURCE)}`);
  console.log(`Target           : ${rel(targetRoot)}`);
  console.log(`Mode             : ${args.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  // 1) Copy runner code (harness + all adapters).
  const runnerTargets = [
    { src: path.join(RUNNER_SOURCE, 'harness.js'), dst: path.join(targetRoot, 'harness.js') },
    { src: path.join(RUNNER_SOURCE, 'adapters'), dst: path.join(targetRoot, 'adapters') },
  ];
  for (const { src, dst } of runnerTargets) {
    if (!fs.existsSync(src)) {
      console.warn(`! Skipping (missing source): ${rel(src)}`);
      continue;
    }
    copyTree(src, dst, args.dryRun);
    console.log(`✓ runner: ${rel(src)} -> ${rel(dst)}`);
  }

  // 2) Copy fixtures for selected steps.
  const allSteps = detectSteps(FIXTURES_SOURCE);
  const steps = args.step ? [args.step] : allSteps;
  if (args.step && !allSteps.includes(args.step)) {
    console.error(
      `✗ Step '${args.step}' has no fixtures at ${rel(path.join(FIXTURES_SOURCE, args.step, 'cases'))}`
    );
    process.exit(1);
  }
  if (steps.length === 0) {
    console.warn('! No steps with fixtures detected.');
  }
  for (const step of steps) {
    const src = path.join(FIXTURES_SOURCE, step, 'cases');
    const dst = path.join(targetRoot, 'fixtures', step, 'cases');
    copyTree(src, dst, args.dryRun);
    console.log(`✓ fixtures[${step}]: ${rel(src)} -> ${rel(dst)}`);
  }

  console.log('');
  console.log(args.dryRun ? 'Dry run complete. No files written.' : 'Sync complete.');
  if (!args.dryRun) {
    console.log('');
    console.log('Next:');
    console.log(`  1) cd ${rel(runtimePath)} && npm start`);
    console.log('  2) Open http://localhost:8000 in a browser, wait for ST to load.');
    console.log('  3) Open devtools console, paste:');
    console.log(
      `     import('/baseline-runner/adapters/${steps[0] ?? 'macros'}.js').then(m => m.run())`
    );
  }
}

try {
  main();
} catch (e) {
  console.error('Sync failed:', e.message);
  process.exit(1);
}
