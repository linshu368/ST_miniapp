#!/usr/bin/env node
/**
 * Step 0.4 — baseline diff tool.
 *
 * Reads the ST ground-truth baseline and the miniAPP candidate
 * baseline from `test/fixtures/macros/baselines/`, then per-case
 * per-field reports any divergences.
 *
 * Hard indicator (the only thing that gates Step 0):
 *   - `output.text` MUST match byte-exact for every case.
 *
 * Soft indicators (printed but do not gate):
 *   - `output.meta.macrosUsed` set equality
 *   - `output.meta.warnings`   array equality
 *   - `output.meta.envSnapshot` deep equality
 *   - `output.meta.error`      string equality
 *
 * Usage from the backend package:
 *
 *   pnpm --filter @miniapp/backend exec node scripts/diff-baselines.mjs
 *
 * Or specify explicit files:
 *
 *   node scripts/diff-baselines.mjs \
 *       --st     test/fixtures/macros/baselines/sillytavern-original-macros-20260429-2022.json \
 *       --miniapp test/fixtures/macros/baselines/miniapp-macros-20260429-2115.json
 *
 * Default behaviour: latest `sillytavern-original-macros-*.json`
 * (lexicographic max) vs latest `miniapp-macros-*.json`.
 *
 * Exit code:
 *   0 = all hard indicators pass (text byte-equal on every case)
 *   1 = at least one hard mismatch, OR baselines couldn't be loaded
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = resolve(__dirname, '..', 'test/fixtures/macros/baselines');

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { st: null, miniapp: null, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--st') args.st = argv[++i];
    else if (a === '--miniapp') args.miniapp = argv[++i];
    else if (a === '-v' || a === '--verbose') args.verbose = true;
    else if (a === '-h' || a === '--help') {
      console.log(`Usage:
  node scripts/diff-baselines.mjs [--st <path>] [--miniapp <path>] [-v]

Options:
  --st <path>       ST ground-truth baseline. Defaults to latest
                    sillytavern-original-macros-*.json under
                    test/fixtures/macros/baselines/.
  --miniapp <path>  miniAPP candidate baseline. Defaults to latest
                    miniapp-macros-*.json in the same directory.
  -v, --verbose     Print envSnapshot diffs (otherwise only summarised).
`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function pickLatestBaseline(prefix) {
  const entries = await readdir(BASELINES_DIR);
  const candidates = entries.filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
  if (candidates.length === 0) return null;
  return resolve(BASELINES_DIR, candidates[candidates.length - 1]);
}

// ─── Diff primitives ────────────────────────────────────────────────────────

function arrayEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (!arrayEqual(ak, bk)) return false;
  for (const k of ak) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

/**
 * Returns a list of `<path>: <stExpected> != <miniapp>` strings for the
 * fields where two objects differ. Recurses into nested objects/arrays.
 */
function deepDiffPaths(a, b, prefix = '') {
  const out = [];
  if (a === b) return out;
  if (typeof a !== typeof b || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${prefix || '<root>'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    return out;
  }
  if (typeof a !== 'object') {
    if (a !== b) out.push(`${prefix || '<root>'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      out.push(...deepDiffPaths(a[i], b[i], `${prefix}[${i}]`));
    }
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    out.push(...deepDiffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

/**
 * Print a one-line preview of two strings showing the first byte at
 * which they diverge, with a few characters of context on each side.
 * Useful when {{...}} substitution drifts deep inside a long template.
 */
function previewTextDiff(expected, actual) {
  const n = Math.min(expected.length, actual.length);
  let i = 0;
  while (i < n && expected[i] === actual[i]) i++;
  const ctxStart = Math.max(0, i - 20);
  const ctxEnd = Math.min(Math.max(expected.length, actual.length), i + 20);
  const head = JSON.stringify(expected.slice(ctxStart, i));
  const got = JSON.stringify(actual.slice(i, ctxEnd));
  const want = JSON.stringify(expected.slice(i, ctxEnd));
  return `   first divergence @ byte ${i} (after ${head})\n     expected ${want}\n     actual   ${got}`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function loadBaseline(label, path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.results)) {
      throw new Error(`Invalid baseline: results is not an array (${path})`);
    }
    return parsed;
  } catch (e) {
    console.error(`[diff-baselines] failed to load ${label} baseline at ${path}:`, e.message);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);

  const stPath = args.st ?? (await pickLatestBaseline('sillytavern-original-macros-'));
  const miniappPath = args.miniapp ?? (await pickLatestBaseline('miniapp-macros-'));

  if (!stPath) {
    console.error(
      '[diff-baselines] no ST baseline found. Provide --st or place a sillytavern-original-macros-*.json under baselines/.'
    );
    process.exit(1);
  }
  if (!miniappPath) {
    console.error(
      '[diff-baselines] no miniAPP baseline found. Run scripts/run-miniapp-baseline.mjs first.'
    );
    process.exit(1);
  }

  console.log(`[diff-baselines] ST     : ${stPath}`);
  console.log(`[diff-baselines] miniAPP: ${miniappPath}`);
  console.log('');

  const st = await loadBaseline('ST', stPath);
  const mini = await loadBaseline('miniAPP', miniappPath);
  if (!st || !mini) process.exit(1);

  // Index by caseId so we tolerate ordering differences.
  const stIndex = new Map(st.results.map((r) => [r.caseId, r]));
  const miniIndex = new Map(mini.results.map((r) => [r.caseId, r]));
  const allIds = new Set([...stIndex.keys(), ...miniIndex.keys()]);

  let hardFail = 0;
  let softFail = 0;
  let fullPass = 0;

  for (const caseId of [...allIds].sort()) {
    const stEntry = stIndex.get(caseId);
    const miniEntry = miniIndex.get(caseId);

    if (!stEntry) {
      console.log(`MISSING-ST   ${caseId}`);
      hardFail++;
      continue;
    }
    if (!miniEntry) {
      console.log(`MISSING-MINI ${caseId}`);
      hardFail++;
      continue;
    }

    const stOut = stEntry.output ?? {};
    const miOut = miniEntry.output ?? {};

    const textOk = stOut.text === miOut.text;
    const macrosOk = arrayEqual(stOut.meta?.macrosUsed ?? [], miOut.meta?.macrosUsed ?? []);
    const warnOk = arrayEqual(stOut.meta?.warnings ?? [], miOut.meta?.warnings ?? []);
    const envOk = deepEqual(stOut.meta?.envSnapshot ?? {}, miOut.meta?.envSnapshot ?? {});
    const errOk = (stOut.meta?.error ?? null) === (miOut.meta?.error ?? null);

    const isHardOk = textOk;
    const isSoftOk = macrosOk && warnOk && envOk && errOk;

    let label;
    if (isHardOk && isSoftOk) {
      label = 'OK';
      fullPass++;
    } else if (isHardOk) {
      label = 'OK*'; // hard pass, soft mismatch
      softFail++;
    } else {
      label = 'FAIL'; // hard mismatch — Step 0 gating
      hardFail++;
    }

    console.log(`${label.padEnd(5)} ${caseId}`);

    if (!textOk) {
      console.log(
        `   text: BYTE-MISMATCH (expected ${stOut.text?.length ?? 0} bytes, got ${miOut.text?.length ?? 0} bytes)`
      );
      console.log(previewTextDiff(stOut.text ?? '', miOut.text ?? ''));
    }
    if (!macrosOk) {
      const stSet = new Set(stOut.meta?.macrosUsed ?? []);
      const miSet = new Set(miOut.meta?.macrosUsed ?? []);
      const missing = [...stSet].filter((x) => !miSet.has(x));
      const extra = [...miSet].filter((x) => !stSet.has(x));
      if (missing.length) console.log(`   macrosUsed missing in miniAPP: [${missing.join(', ')}]`);
      if (extra.length) console.log(`   macrosUsed extra in miniAPP:   [${extra.join(', ')}]`);
    }
    if (!warnOk) {
      console.log(
        `   warnings: ${stOut.meta?.warnings?.length ?? 0} vs ${miOut.meta?.warnings?.length ?? 0}`
      );
    }
    if (!envOk) {
      const diffs = deepDiffPaths(stOut.meta?.envSnapshot ?? {}, miOut.meta?.envSnapshot ?? {});
      if (args.verbose) {
        for (const d of diffs) console.log(`   envSnapshot ${d}`);
      } else {
        console.log(`   envSnapshot: ${diffs.length} field(s) differ (run with -v for details)`);
      }
    }
    if (!errOk) {
      console.log(
        `   error mismatch: ST=${JSON.stringify(stOut.meta?.error)} miniAPP=${JSON.stringify(miOut.meta?.error)}`
      );
    }
  }

  console.log('');
  console.log(
    `[diff-baselines] summary: full-pass=${fullPass} hard-only=${softFail} fail=${hardFail} (out of ${allIds.size})`
  );
  console.log('');
  if (hardFail === 0) {
    console.log('[diff-baselines] HARD-PASS — Step 0 byte-exact gate satisfied.');
    process.exit(0);
  } else {
    console.log('[diff-baselines] HARD-FAIL — Step 0 NOT closed. Fix the cases above.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[diff-baselines] fatal:', e);
  process.exit(1);
});
