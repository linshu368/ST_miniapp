#!/usr/bin/env node
/**
 * Step 1.8 — miniAPP candidate baseline runner（instruct）
 *
 * 加载 test/fixtures/instruct/cases/{index.json + *.json} 里的 34 个 case，
 * 通过 src/prompt-engine/instruct.ts 门面跑一遍，按 target dispatch，把
 * 输出归一化成与 ST adapter 完全一致的 baseline shape，落地到
 * test/fixtures/instruct/baselines/miniapp-instruct-YYYYMMDD-HHmm.json。
 *
 * Diff 由 scripts/diff-instruct-baselines.mjs 单独负责。
 *
 * 用法（来自 backend package）:
 *   pnpm instruct:baseline
 *
 * 与 ST adapter 的契约对齐（必须保持一致，否则 diff 会无意义）：
 *   - dispatchTarget 7 条分支与 adapters/instruct.js 同结构
 *   - getInstructMacros 输出归一化策略与 ST adapter 同：
 *     `{ regex, replace }[]` → `{ regexSource, regexFlags, replacement }[]`
 *   - output.text 仅对 outputType='string' 的 case 承载真值；其它 case
 *     的真值在 output.meta.outputValue 里
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

import {
  formatInstructChat,
  formatInstructStoryString,
  formatInstructExamples,
  formatInstructPrompt,
  formatInstructSystemPrompt,
  getInstructStoppingSequences,
  getInstructMacros,
} from '../src/prompt-engine/instruct.ts';

// ─── Paths ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_BACKEND = resolve(__dirname, '..');
const FIXTURES_DIR = resolve(REPO_BACKEND, 'test/fixtures/instruct');
const CASES_DIR = resolve(FIXTURES_DIR, 'cases');
const BASELINES_DIR = resolve(FIXTURES_DIR, 'baselines');

const SCHEMA_VERSION = '1.0';
const ENGINE_LABEL = 'miniapp';

// ─── Per-case dispatch（与 ST adapter dispatchTarget 一一对应）───────────────

/**
 * @param {string} target
 * @param {object} input
 * @returns {{ outputType: 'string'|'string[]'|'macro-array', outputValue: any }}
 */
function dispatchTarget(target, input) {
  const { ctx, args, instruct, context, sysprompt } = input;

  const facadeCtx = {
    name1: ctx.name1,
    name2: ctx.name2,
    selectedGroup: ctx.selectedGroup,
    groups: ctx.groups,
    characters: ctx.characters,
  };

  switch (target) {
    case 'formatInstructChat': {
      const value = formatInstructChat({
        name: args.name,
        mes: args.mes,
        isUser: args.isUser,
        isNarrator: args.isNarrator,
        forceAvatar: args.forceAvatar ?? '',
        forceOutputSequence: args.forceOutputSequence ?? null,
        instruct,
        context,
        sysprompt,
        ctx: facadeCtx,
      });
      return { outputType: 'string', outputValue: value };
    }
    case 'formatInstructStoryString': {
      const value = formatInstructStoryString(args.storyString, {
        instruct,
        context,
        sysprompt,
        ctx: facadeCtx,
      });
      return { outputType: 'string', outputValue: value };
    }
    case 'formatInstructExamples': {
      const value = formatInstructExamples(args.mesExamplesArray, {
        instruct,
        context,
        sysprompt,
        ctx: facadeCtx,
      });
      return { outputType: 'string[]', outputValue: value };
    }
    case 'formatInstructPrompt': {
      const value = formatInstructPrompt({
        name: args.name,
        isImpersonate: args.isImpersonate,
        promptBias: args.promptBias ?? '',
        isQuiet: args.isQuiet ?? false,
        isQuietToLoud: args.isQuietToLoud ?? false,
        instruct,
        context,
        sysprompt,
        ctx: facadeCtx,
      });
      return { outputType: 'string', outputValue: value };
    }
    case 'formatInstructSystemPrompt': {
      const value = formatInstructSystemPrompt(args.systemPrompt, { instruct });
      return { outputType: 'string', outputValue: value };
    }
    case 'getInstructStoppingSequences': {
      const value = getInstructStoppingSequences({
        instruct,
        context,
        sysprompt,
        useStopStrings: args.useStopStrings ?? null,
        ctx: facadeCtx,
      });
      return { outputType: 'string[]', outputValue: value };
    }
    case 'getInstructMacros': {
      // 注意：getInstructMacros 门面会读 ctx 里的 prefer_character_prompt
      // ——通过 args.preferCharacterPrompt 传进去（门面内部把它塞进
      // power_user 的 prefer_character_prompt 字段，与 ST adapter 一致）
      const macros = getInstructMacros({
        instruct,
        context,
        sysprompt,
        preferCharacterPrompt: args.preferCharacterPrompt ?? false,
        charPrompt: args.charPrompt ?? '',
        ctx: facadeCtx,
      });
      // 归一化（与 adapters/instruct.js 完全相同的策略）
      const normalized = macros.map((m) => ({
        regexSource: m.regex.source,
        regexFlags: m.regex.flags,
        replacement: typeof m.replace === 'function' ? m.replace() : String(m.replace),
      }));
      return { outputType: 'macro-array', outputValue: normalized };
    }
    default:
      throw new Error(`[run-miniapp-instruct-baseline] unknown target: ${target}`);
  }
}

/**
 * 跑一个 case，输出与 ST adapter 完全等价的 envelope。
 * @param {object} caseObj
 * @returns {{ text: string, meta: object }}
 */
function runOneCase(caseObj) {
  const { input, target, caseId } = caseObj;
  let outputType = 'string';
  /** @type {any} */
  let outputValue = '';
  let errorString = null;
  /** @type {string[]} */
  const warnings = [];

  // 抓 console.warn / console.error 里 instruct/macro 相关的信息（与 ST
  // 端 captureConsole 行为对齐）
  const origWarn = console.warn;
  const origError = console.error;
  /** @param {string} level */
  const sink =
    (level) =>
    (...args) => {
      try {
        const line = `[${level}] ` + args.map(stringifyForLog).join(' ');
        if (/instruct/i.test(line) || /macro/i.test(line)) {
          warnings.push(line);
        }
      } catch {
        /* swallow */
      }
    };
  console.warn = sink('warn');
  console.error = sink('error');

  try {
    const result = dispatchTarget(target, input);
    outputType = result.outputType;
    outputValue = result.outputValue;
  } catch (e) {
    errorString = e?.stack ?? String(e);
    origError(`[run-miniapp-instruct-baseline] case ${caseId} threw:`, e);
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }

  // ST adapter 的 text 字段约定：仅 outputType='string' 时承载真值；其它走 ''
  const text = outputType === 'string' ? /** @type {string} */ (outputValue) : '';

  return {
    text,
    meta: {
      outputType,
      outputValue,
      // 与 ST harness 一致的兜底字段：macros 时代字段保持空，error 走 null/stack
      macrosUsed: [],
      warnings,
      envSnapshot: {},
      error: errorString,
    },
  };
}

function stringifyForLog(v) {
  if (v instanceof Error) return v.stack ?? v.message;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

// ─── Driver ────────────────────────────────────────────────────────────────

async function loadCases() {
  const indexRaw = await readFile(resolve(CASES_DIR, 'index.json'), 'utf8');
  const index = JSON.parse(indexRaw);
  if (!Array.isArray(index?.cases)) {
    throw new Error(`Invalid index.json (no .cases array): ${CASES_DIR}/index.json`);
  }
  const out = [];
  for (const filename of index.cases) {
    const path = resolve(CASES_DIR, filename);
    const raw = await readFile(path, 'utf8');
    out.push(JSON.parse(raw));
  }
  return out;
}

function makeBaselineFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  return `${ENGINE_LABEL}-instruct-${yyyy}${mm}${dd}-${hh}${mi}.json`;
}

function readPackageVersion() {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json');
    return `${pkg.name}@${pkg.version}`;
  } catch {
    return 'miniapp-backend@unknown';
  }
}

async function main() {
  const startedAt = new Date();
  const cases = await loadCases();
  console.log(`[run-miniapp-instruct-baseline] loaded ${cases.length} case(s) from ${CASES_DIR}`);

  const results = [];
  for (const caseObj of cases) {
    let output;
    try {
      output = runOneCase(caseObj);
    } catch (e) {
      console.error(
        `[run-miniapp-instruct-baseline] case ${caseObj.caseId} threw outside the engine:`,
        e
      );
      output = {
        text: '',
        meta: {
          outputType: 'string',
          outputValue: '',
          macrosUsed: [],
          warnings: [],
          envSnapshot: {},
          error: e?.stack ?? String(e),
        },
      };
    }
    const status = output.meta.error ? 'ERROR' : 'OK';
    console.log(`[run-miniapp-instruct-baseline] ${status.padEnd(5)} ${caseObj.caseId}`);
    results.push({
      caseId: caseObj.caseId,
      target: caseObj.target,
      input: caseObj.input,
      output,
    });
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    runMeta: {
      runAt: startedAt.toISOString(),
      engine: ENGINE_LABEL,
      stVersion: readPackageVersion(),
      userAgent: `Node.js ${process.version}`,
      notes:
        'Step 1.8 candidate: miniAPP-ported instruct.ts façade over instruct-mode.js cut-line port',
      stepName: 'instruct',
    },
    results,
  };

  const filename = makeBaselineFilename(startedAt);
  const outPath = resolve(BASELINES_DIR, filename);
  await writeFile(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`\n[run-miniapp-instruct-baseline] wrote ${outPath}`);
}

main().catch((e) => {
  console.error('[run-miniapp-instruct-baseline] fatal:', e);
  process.exit(1);
});
