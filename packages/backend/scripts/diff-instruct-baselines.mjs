#!/usr/bin/env node
/**
 * Step 1.9 — instruct baseline diff 工具
 *
 * 读 ST ground-truth + miniAPP candidate，按 outputType 分支决定
 * 怎么比对：
 *
 *   - outputType='string'      → output.text 字节级
 *   - outputType='string[]'    → output.meta.outputValue 逐元素字节级
 *   - outputType='macro-array' → output.meta.outputValue 逐条比 regexSource/
 *                                regexFlags/replacement 三元组
 *
 * Hard 指标（gating Step 1）：上面三类按 outputType 各自相等。
 * Soft 指标（仅打印）：warnings / outputType 不一致 / target 漂移。
 *
 * Usage（来自 backend package）：
 *   pnpm instruct:diff
 *
 * 默认行为：取 baselines/ 里最新的
 *   sillytavern-original-instruct-*.json vs miniapp-instruct-*.json
 * 对比。可用 --st / --miniapp 显式指定。
 *
 * Exit code:
 *   0 = 全部 hard 通过
 *   1 = 至少一条 hard 失败 / baseline 不可读
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = resolve(__dirname, '..', 'test/fixtures/instruct/baselines');

// ─── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { st: null, miniapp: null, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--st') args.st = argv[++i];
    else if (a === '--miniapp') args.miniapp = argv[++i];
    else if (a === '-v' || a === '--verbose') args.verbose = true;
    else if (a === '-h' || a === '--help') {
      console.log(`Usage:
  node scripts/diff-instruct-baselines.mjs [--st <path>] [--miniapp <path>] [-v]

Options:
  --st <path>       ST ground-truth baseline (默认取 baselines/ 里最新的
                    sillytavern-original-instruct-*.json)
  --miniapp <path>  miniAPP candidate baseline (默认最新 miniapp-instruct-*.json)
  -v, --verbose     打印每条 string[] / macro-array 的元素级 diff
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

// ─── Diff primitives ──────────────────────────────────────────────────────

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
 * 按字节定位首处分歧，并打印 ±20 字符 context。
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

/**
 * 比 string[] 的两份输出，返回 { ok, divergeIdx, msg } 三元组。
 */
function compareStringArray(expected, actual) {
  if (!Array.isArray(expected) || !Array.isArray(actual)) {
    return {
      ok: false,
      msg: `not array on both sides: expected=${typeof expected} actual=${typeof actual}`,
    };
  }
  if (expected.length !== actual.length) {
    return {
      ok: false,
      msg: `length mismatch: expected=${expected.length} actual=${actual.length}`,
    };
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) {
      return {
        ok: false,
        divergeIdx: i,
        msg: `element[${i}] differs:\n${previewTextDiff(expected[i] ?? '', actual[i] ?? '')}`,
      };
    }
  }
  return { ok: true };
}

/**
 * 比 macro-array 的两份输出。每条 NormalizedMacro 三个字段都要相等。
 */
function compareMacroArray(expected, actual) {
  if (!Array.isArray(expected) || !Array.isArray(actual)) {
    return { ok: false, msg: 'not array on both sides' };
  }
  if (expected.length !== actual.length) {
    return {
      ok: false,
      msg: `length mismatch: expected=${expected.length} actual=${actual.length}`,
    };
  }
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    const a = actual[i];
    if (
      e?.regexSource !== a?.regexSource ||
      e?.regexFlags !== a?.regexFlags ||
      e?.replacement !== a?.replacement
    ) {
      return {
        ok: false,
        divergeIdx: i,
        msg: `entry[${i}] differs:\n     expected ${JSON.stringify(e)}\n     actual   ${JSON.stringify(a)}`,
      };
    }
  }
  return { ok: true };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function loadBaseline(label, path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.results)) {
      throw new Error(`Invalid baseline: results is not an array (${path})`);
    }
    return parsed;
  } catch (e) {
    console.error(`[diff-instruct] failed to load ${label} baseline at ${path}:`, e.message);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);

  const stPath = args.st ?? (await pickLatestBaseline('sillytavern-original-instruct-'));
  const miniappPath = args.miniapp ?? (await pickLatestBaseline('miniapp-instruct-'));

  if (!stPath) {
    console.error(
      '[diff-instruct] no ST baseline found. 提供 --st 或者把 sillytavern-original-instruct-*.json 放到 baselines/。'
    );
    process.exit(1);
  }
  if (!miniappPath) {
    console.error(
      '[diff-instruct] no miniAPP baseline found. 先跑 scripts/run-miniapp-instruct-baseline.mjs。'
    );
    process.exit(1);
  }

  console.log(`[diff-instruct] ST     : ${stPath}`);
  console.log(`[diff-instruct] miniAPP: ${miniappPath}`);
  console.log('');

  const st = await loadBaseline('ST', stPath);
  const mini = await loadBaseline('miniAPP', miniappPath);
  if (!st || !mini) process.exit(1);

  // 按 caseId 索引（容忍顺序差）
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
    const stType = stOut.meta?.outputType;
    const miType = miOut.meta?.outputType;

    // outputType 不一致：直接 hard fail（前置不变量）
    if (stType !== miType) {
      console.log(`FAIL  ${caseId}`);
      console.log(`   outputType drift: ST=${stType} miniAPP=${miType}`);
      hardFail++;
      continue;
    }

    // target 漂移（schema 顶层）：hard fail
    if (stEntry.target && miniEntry.target && stEntry.target !== miniEntry.target) {
      console.log(`FAIL  ${caseId}`);
      console.log(`   target drift: ST=${stEntry.target} miniAPP=${miniEntry.target}`);
      hardFail++;
      continue;
    }

    let hardOk = false;
    let hardMsg = '';

    switch (stType) {
      case 'string': {
        const ok = stOut.text === miOut.text;
        hardOk = ok;
        if (!ok) {
          hardMsg = `text BYTE-MISMATCH (expected ${stOut.text?.length ?? 0} bytes, got ${miOut.text?.length ?? 0} bytes)\n${previewTextDiff(stOut.text ?? '', miOut.text ?? '')}`;
        }
        break;
      }
      case 'string[]': {
        const cmp = compareStringArray(stOut.meta?.outputValue, miOut.meta?.outputValue);
        hardOk = cmp.ok;
        if (!cmp.ok) hardMsg = cmp.msg;
        break;
      }
      case 'macro-array': {
        const cmp = compareMacroArray(stOut.meta?.outputValue, miOut.meta?.outputValue);
        hardOk = cmp.ok;
        if (!cmp.ok) hardMsg = cmp.msg;
        break;
      }
      default: {
        hardOk = false;
        hardMsg = `unknown outputType: ${stType}`;
      }
    }

    // Soft：warnings 不一致 + error 不一致
    const stWarn = stOut.meta?.warnings ?? [];
    const miWarn = miOut.meta?.warnings ?? [];
    const warnOk = arrayEqual(stWarn, miWarn);
    const errOk = (stOut.meta?.error ?? null) === (miOut.meta?.error ?? null);
    const softOk = warnOk && errOk;

    let label;
    if (hardOk && softOk) {
      label = 'OK';
      fullPass++;
    } else if (hardOk) {
      label = 'OK*'; // hard 过、soft 异
      softFail++;
    } else {
      label = 'FAIL';
      hardFail++;
    }

    console.log(`${label.padEnd(5)} ${caseId}  [${stType}]`);
    if (!hardOk) {
      console.log(`   ${hardMsg}`);
    }
    if (!warnOk) {
      console.log(`   warnings: ${stWarn.length} vs ${miWarn.length}`);
      if (args.verbose) {
        console.log(`   ST warnings  : ${JSON.stringify(stWarn)}`);
        console.log(`   mini warnings: ${JSON.stringify(miWarn)}`);
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
    `[diff-instruct] summary: full-pass=${fullPass} hard-only=${softFail} fail=${hardFail} (out of ${allIds.size})`
  );
  console.log('');
  if (hardFail === 0) {
    console.log('[diff-instruct] HARD-PASS — Step 1 byte-exact gate satisfied.');
    process.exit(0);
  } else {
    console.log('[diff-instruct] HARD-FAIL — Step 1 NOT closed. Fix the cases above.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[diff-instruct] fatal:', e);
  process.exit(1);
});
