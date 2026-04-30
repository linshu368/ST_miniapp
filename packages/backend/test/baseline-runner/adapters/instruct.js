/**
 * Step 1 baseline-runner adapter — ST 浏览器端入口
 *
 * 用法（粘贴到 ST 浏览器 devtools console）：
 *
 *   import('/baseline-runner/adapters/instruct.js').then(m => m.run())
 *
 * Adapter 职责：
 *   1. 一次性把 ST 全局（power_user / name1 / name2 / selected_group / ...）
 *      备份到 GLOBAL_BACKUP，结束时还原；
 *   2. 对每个 case：
 *      a. 把 case.input.instruct/context/sysprompt 整体灌进 power_user，
 *         setUserName(name1) / setCharacterName(name2)；
 *      b. 按 case.target dispatch 到对应 instruct-mode.js export 函数；
 *      c. 把返回值按 type=string|string[]|macro-array 归一化；
 *   3. 触发 baseline JSON 下载。
 *
 * macro-array 归一化：getInstructMacros 返回 `[{ regex: RegExp,
 * replace: () => string }]`——RegExp/function 不可序列化。我们落 baseline
 * 时把它转成 NormalizedMacro：
 *   { regexSource: regex.source, regexFlags: regex.flags, replacement: replace() }
 * 闭包 replace() 调用一次性求值，记录字面量。
 */

'use strict';

import { runStep, captureConsole } from '../harness.js';
import { name1, name2, setCharacterName, setUserName } from '/script.js';
import { selected_group } from '/scripts/group-chats.js';
import { power_user } from '/scripts/power-user.js';
import {
  formatInstructModeChat,
  formatInstructModeExamples,
  formatInstructModePrompt,
  formatInstructModeStoryString,
  formatInstructModeSystemPrompt,
  getInstructMacros,
  getInstructStoppingSequences,
} from '/scripts/instruct-mode.js';

// ─── Public entrypoint ──────────────────────────────────────────────────────

export async function run() {
  return runStep('instruct', {
    setupOnce: setupGlobalState,
    runOneCase,
    teardownOnce: restoreGlobalState,
    notes:
      'Step 1 baseline: 7 instruct-mode.js exports + getInstructMacros normalized to NormalizedMacro[]',
  });
}

// ─── Once-per-run state management ──────────────────────────────────────────

const GLOBAL_BACKUP = {};

function setupGlobalState() {
  // 深拷一份当前 power_user 的 instruct/context/sysprompt 子树，避免 case
  // 之间互相污染——我们每个 case 都会整体改写它们。
  GLOBAL_BACKUP.instruct = structuredClone(power_user?.instruct ?? {});
  GLOBAL_BACKUP.context = structuredClone(power_user?.context ?? {});
  GLOBAL_BACKUP.sysprompt = structuredClone(power_user?.sysprompt ?? {});
  GLOBAL_BACKUP.preferCharacterPrompt = power_user?.prefer_character_prompt;
  GLOBAL_BACKUP.name1 = name1;
  GLOBAL_BACKUP.name2 = name2;
  // selected_group 是 group-chats.js 的 export let，我们从它的实时值取，
  // 但不主动改它（每个 case 通过 ctx.selectedGroup 只是用来对比，不改全局）。
  GLOBAL_BACKUP.selectedGroup = selected_group;
}

function restoreGlobalState() {
  if (!power_user) return;
  Object.assign(power_user, {
    instruct: GLOBAL_BACKUP.instruct,
    context: GLOBAL_BACKUP.context,
    sysprompt: GLOBAL_BACKUP.sysprompt,
    prefer_character_prompt: GLOBAL_BACKUP.preferCharacterPrompt,
  });
  setUserName(GLOBAL_BACKUP.name1, { toastPersonaNameChange: false });
  setCharacterName(GLOBAL_BACKUP.name2);
}

// ─── Per-case execution ─────────────────────────────────────────────────────

/**
 * @param {object} caseObj  // { caseId, target, description, input }
 * @returns {Promise<{ text: string, meta: object }>}
 *
 * 注意：harness.runStep 期望 runOneCase 返回 `{ text, meta }`——这是 macros
 * 走的格式。Step 1 我们让 text 字段承载多态：
 *   - target 返回 string → text=该字符串，meta.outputType='string', meta.outputValue=text
 *   - target 返回 string[] → text='', meta.outputType='string[]', meta.outputValue=数组
 *   - target 返回 NormalizedMacro[] → text='', meta.outputType='macro-array', meta.outputValue=数组
 * 等 PR-4 写 diff 工具时再按 outputType 分支。harness 自身的 text byte-equal
 * 检查仍按 text 字段进行（这对返 string 的 4 个 target 仍生效）。
 */
async function runOneCase(caseObj) {
  const { input, target, caseId } = caseObj;

  // 1) 整体灌 instruct / context / sysprompt 到 power_user
  if (power_user) {
    power_user.instruct = structuredClone(input.instruct);
    power_user.context = structuredClone(input.context);
    power_user.sysprompt = structuredClone(input.sysprompt);
    // getInstructMacros 还会读 prefer_character_prompt，这里按 args 显式写
    if (target === 'getInstructMacros') {
      power_user.prefer_character_prompt = !!input.args.preferCharacterPrompt;
    } else {
      power_user.prefer_character_prompt = false;
    }
  }

  // 2) name1 / name2
  setUserName(input.ctx.name1, { toastPersonaNameChange: false });
  setCharacterName(input.ctx.name2);

  // 3) dispatch by target
  let outputType = 'string';
  let outputValue = '';
  let warnings = [];
  let errorString = null;

  try {
    const captured = await captureConsole(() => dispatchTarget(target, input));
    outputType = captured.result.outputType;
    outputValue = captured.result.outputValue;
    warnings = captured.warnings.filter((w) => /instruct/i.test(w) || /macro/i.test(w));
  } catch (e) {
    errorString = e?.stack ?? String(e);
    console.error(`[adapter:instruct] case ${caseId} threw:`, e);
  }

  // 4) 返回 harness 期望的形状。text 字段只对 type=string 有意义；
  // string[] / macro-array 真正的值放进 meta.outputValue。PR-4 的 diff
  // 工具按 meta.outputType 分支。
  const text = outputType === 'string' ? /** @type {string} */ (outputValue) : '';
  return {
    text,
    meta: {
      outputType,
      outputValue,
      warnings,
      error: errorString,
    },
  };
}

/**
 * 按 target dispatch。返回归一化后的 { outputType, outputValue }。
 * @param {string} target
 * @param {object} input
 */
function dispatchTarget(target, input) {
  const { ctx, args } = input;

  switch (target) {
    case 'formatInstructChat': {
      const value = formatInstructModeChat(
        args.name,
        args.mes,
        args.isUser,
        args.isNarrator,
        args.forceAvatar ?? '',
        ctx.name1,
        ctx.name2,
        args.forceOutputSequence ?? false,
        input.instruct
      );
      return { outputType: 'string', outputValue: value };
    }
    case 'formatInstructStoryString': {
      const value = formatInstructModeStoryString(args.storyString, {
        customInstruct: input.instruct,
        customContext: input.context,
      });
      return { outputType: 'string', outputValue: value };
    }
    case 'formatInstructExamples': {
      const value = formatInstructModeExamples(args.mesExamplesArray, ctx.name1, ctx.name2);
      return { outputType: 'string[]', outputValue: value };
    }
    case 'formatInstructPrompt': {
      const value = formatInstructModePrompt(
        args.name,
        args.isImpersonate,
        args.promptBias ?? '',
        ctx.name1,
        ctx.name2,
        args.isQuiet ?? false,
        args.isQuietToLoud ?? false,
        input.instruct
      );
      return { outputType: 'string', outputValue: value };
    }
    case 'formatInstructSystemPrompt': {
      const value = formatInstructModeSystemPrompt(args.systemPrompt, input.instruct);
      return { outputType: 'string', outputValue: value };
    }
    case 'getInstructStoppingSequences': {
      const value = getInstructStoppingSequences({
        customInstruct: input.instruct,
        useStopStrings: args.useStopStrings ?? null,
      });
      return { outputType: 'string[]', outputValue: value };
    }
    case 'getInstructMacros': {
      // ST 原版签名 getInstructMacros(env)，env 只有 charPrompt 字段
      const macros = getInstructMacros({ charPrompt: args.charPrompt ?? '' });
      const normalized = macros.map((m) => ({
        regexSource: m.regex.source,
        regexFlags: m.regex.flags,
        // 一次性 invoke 闭包，把当前 power_user 状态下的 replacement 落字面量
        replacement: typeof m.replace === 'function' ? m.replace() : String(m.replace),
      }));
      return { outputType: 'macro-array', outputValue: normalized };
    }
    default:
      throw new Error(`[adapter:instruct] unknown target: ${target}`);
  }
}
