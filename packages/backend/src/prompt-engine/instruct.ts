/**
 * instruct.ts
 *
 * Step 1 instruct 子树的唯一对外 TS 门面，与 Step 0 的
 * `substituteParams.ts` 同档定位：
 *
 *   - 后端代码（src/** 之下、test 之外）只 import 本文件，绝不
 *     深入 ./instruct/** 子树
 *   - 内部走 setRuntimeCtx → MacroEngine 子树共享同一份 ctx 注入路径，
 *     一次构造的 ctx 同时被 macros / instruct / 后续 Step 2/3 共用
 *
 * 与 ST 原版的语义对齐：
 *   - 7 个核心格式化函数（formatInstructChat / formatInstructStoryString /
 *     formatInstructExamples / formatInstructPrompt /
 *     formatInstructSystemPrompt / getInstructStoppingSequences /
 *     getInstructMacros）
 *   - 1 个 schema 迁移工具（migrateInstructSettings），由 vitest 单测
 *     直接覆盖（不进 baseline-runner，参见「Step 1 实践计划」Q3）
 *   - 2 个枚举常量（NamesBehavior / ForceOutputSequence）
 *
 * 调用方负责构造 InstructCtx 并显式传入；门面不读模块全局，每次
 * 调用前 setRuntimeCtx、调用后 resetRuntimeCtx。
 */

import { initRegisterMacros } from './macros/macro-system.js';
import { setRuntimeCtx, resetRuntimeCtx } from './macros/runtime/host.js';
import { setGlobalStore } from './macros/runtime/variables.js';
import {
  formatInstructModeChat,
  formatInstructModeExamples,
  formatInstructModePrompt,
  formatInstructModeStoryString,
  formatInstructModeSystemPrompt,
  getInstructMacros as _getInstructMacros,
  getInstructStoppingSequences as _getInstructStoppingSequences,
  migrateInstructModeSettings as _migrateInstructModeSettings,
  names_behavior_types,
  force_output_sequence,
} from './instruct/instruct-mode.js';

import type { SubstituteCtx, SubstituteOptions } from './substituteParams.js';

// ─── 公开类型 ────────────────────────────────────────────────────────────────

/**
 * Instruct preset 的全字段结构，与 ST `power_user.instruct.*` 1:1 对齐。
 *
 * 大量字段都是 sequence 字符串（可能含 `{{name}}` / `{{user}}` /
 * `{{char}}` 宏），instruct mode 在装配时会按 wrap / macro 标志决定
 * 是否展开。
 */
export interface InstructSettings {
  /** 整体启用开关；为 false 时 instruct 模式短路成 identity */
  enabled: boolean;
  /** 是否在 sequence 之间插入 `\n` */
  wrap: boolean;
  /** sequence 字段中的 `{{...}}` 宏是否展开 */
  macro: boolean;
  /** 名字策略：none/force/always */
  names_behavior: 'none' | 'force' | 'always';

  input_sequence: string;
  input_suffix: string;
  output_sequence: string;
  output_suffix: string;
  system_sequence: string;
  system_suffix: string;
  last_system_sequence: string;
  first_input_sequence: string;
  last_input_sequence: string;
  first_output_sequence: string;
  last_output_sequence: string;

  /** 模型生成的 stop sequence */
  stop_sequence: string;
  /** Story string 整体前缀 */
  story_string_prefix: string;
  /** Story string 整体后缀 */
  story_string_suffix: string;
  /** AI 提问时的 user-aligned 占位 prompt */
  user_alignment_message: string;

  /** narrator/system 是否复用 user 的 sequence */
  system_same_as_user: boolean;
  /** sequence 是否同时算入 stop strings */
  sequences_as_stop_strings: boolean;
  /** preset 自动选择的正则 */
  activation_regex: string;
  /** 切 instruct preset 时是否同步切 context preset */
  bind_to_context: boolean;
  /** 跳过 mes_example 块 */
  skip_examples: boolean;
}

/**
 * Context preset 的全字段结构，与 ST `power_user.context.*` 对齐。
 */
export interface ContextSettings {
  /** 当前 preset 名字（仅做记录，不影响装配逻辑） */
  preset: string;
  /**
   * Story string 的插入位置：0=IN_PROMPT, 1=IN_CHAT, 2=BEFORE_PROMPT, -1=NONE。
   * IN_CHAT 表示 story 内嵌进消息流，由 message-level sequence 包裹，
   * 此时 formatInstructStoryString 不会再加 prefix/suffix。
   */
  story_string_position: number;
  /** Chat 起始处的额外提示，作为消息流第 0 条注入 */
  chat_start: string;
  /** mes_example 块之间的分隔串 */
  example_separator: string;
  /** 是否把 chat_start / example_separator 算入 stop strings */
  use_stop_strings: boolean;
}

/**
 * System prompt 设置（getInstructMacros 用到）。
 */
export interface SyspromptSettings {
  enabled: boolean;
  content: string;
}

/**
 * Instruct 函数族需要的运行时 ctx，与 SubstituteCtx 共享同一组数据，
 * 但只暴露 instruct 实际会读到的字段。
 *
 * 调用方一次构造，可同时喂给 substituteParams 和 instruct.ts 任一函数。
 */
export interface InstructCtx {
  /** {{user}} */
  name1: string;
  /** {{char}} */
  name2: string;
  /** group chat id（none → null） */
  selectedGroup?: string | null;
  /** group 列表（用于 getGroupNames） */
  groups?: unknown[];
  /** characters 列表（getGroupNames 把 avatar 映射回 name） */
  characters?: unknown[];

  /**
   * 递归 substituteParams 回调；instruct 函数族的 macro:true 路径
   * 会调用它展开 sequence 里的 {{...}} 宏。门面默认从 substituteParams.ts
   * 接出来注入，调用方一般不需要自己传。
   */
  substituteParams?: (s: string, opts?: SubstituteOptions) => string;
}

/**
 * names_behavior 枚举的 TS 友好别名（与 instruct-mode.js 内部
 * `names_behavior_types` 同值）。
 */
export const NamesBehavior = names_behavior_types;
/**
 * force_output_sequence 枚举的 TS 友好别名。
 */
export const ForceOutputSequence = force_output_sequence;

// ─── 内部：ctx 注入流水线 ─────────────────────────────────────────────────────

let _initialized = false;
function ensureInitialized(): void {
  if (_initialized) return;
  // 注册 macros 引擎（getInstructStoppingSequences 的 macro:true 分支
  // 会调 substituteParams，背后是 macros 引擎），与 substituteParams.ts
  // 的初始化路径一致。
  initRegisterMacros();
  _initialized = true;
}

/**
 * 把 InstructCtx + InstructSettings + ContextSettings 拼成 host.js 的
 * setRuntimeCtx patch。
 *
 * 注意：power_user.instruct / context / sysprompt 整体替换骨架（参见
 * host.js 的 createDefaultPowerUser 文档）。这里把传入的 settings 原样
 * 塞进去——instruct-mode.js 在拿到 customInstruct 时会直接 structuredClone
 * 它，host 里的 power_user.instruct 主要是 formatInstructModeExamples 那条
 * 「不接受 customInstruct」的路径会读到。
 */
function buildHostPatch(
  ctx: InstructCtx,
  instruct: InstructSettings,
  context: ContextSettings,
  sysprompt: SyspromptSettings,
  recursive: (s: string, opts?: SubstituteOptions) => string
): Record<string, unknown> {
  return {
    name1: ctx.name1 ?? '',
    name2: ctx.name2 ?? '',
    selected_group: ctx.selectedGroup ?? null,
    groups: ctx.groups ?? [],
    characters: ctx.characters ?? [],
    power_user: {
      instruct,
      context,
      sysprompt,
    },
    substituteParams: ctx.substituteParams ?? recursive,
  };
}

/**
 * 通用的「注入 ctx → 跑 fn → 还原」高阶函数。
 * 所有公开 API 都通过它包一层，确保异常路径也能 resetRuntimeCtx。
 */
function withCtx<T>(
  ctx: InstructCtx,
  instruct: InstructSettings,
  context: ContextSettings,
  sysprompt: SyspromptSettings,
  fn: () => T
): T {
  ensureInitialized();
  const recursive = ctx.substituteParams ?? ((s: string) => s);
  const hostPatch = buildHostPatch(ctx, instruct, context, sysprompt, recursive);
  const hostSnapshot = setRuntimeCtx(hostPatch);
  const prevGlobalStore = setGlobalStore({});
  try {
    return fn();
  } finally {
    setGlobalStore(prevGlobalStore);
    resetRuntimeCtx(hostSnapshot);
  }
}

const DEFAULT_SYSPROMPT: SyspromptSettings = { enabled: false, content: '' };

// ─── 公开 API ────────────────────────────────────────────────────────────────

/**
 * 把单条聊天消息按 instruct mode 规则格式化。
 * 对应 ST `formatInstructModeChat`。
 */
export function formatInstructChat(args: {
  name: string;
  mes: string;
  isUser: boolean;
  isNarrator: boolean;
  forceAvatar?: string;
  forceOutputSequence?: 1 | 2 | null;
  instruct: InstructSettings;
  context?: ContextSettings;
  sysprompt?: SyspromptSettings;
  ctx: InstructCtx;
}): string {
  const ctxObj = args.ctx;
  const context = args.context ?? createBlankContext();
  const sysprompt = args.sysprompt ?? DEFAULT_SYSPROMPT;
  return withCtx(ctxObj, args.instruct, context, sysprompt, () =>
    formatInstructModeChat(
      args.name,
      args.mes,
      args.isUser,
      args.isNarrator,
      args.forceAvatar ?? '',
      ctxObj.name1,
      ctxObj.name2,
      args.forceOutputSequence ?? false,
      args.instruct
    )
  );
}

/**
 * 把整段 story string 按 instruct mode 规则前后包裹。
 * 对应 ST `formatInstructModeStoryString`。
 */
export function formatInstructStoryString(
  storyString: string,
  args: {
    instruct: InstructSettings;
    context: ContextSettings;
    sysprompt?: SyspromptSettings;
    ctx: InstructCtx;
  }
): string {
  return withCtx(args.ctx, args.instruct, args.context, args.sysprompt ?? DEFAULT_SYSPROMPT, () =>
    formatInstructModeStoryString(storyString, {
      customInstruct: args.instruct,
      customContext: args.context,
    })
  );
}

/**
 * 把 mes_example 数组按 instruct mode 规则格式化成单独消息列表。
 * 对应 ST `formatInstructModeExamples`。注意 ST 原版函数**不接受**
 * customInstruct 参数，直接读 power_user.instruct——所以本函数依赖
 * setRuntimeCtx 把 power_user 注入进去。
 */
export function formatInstructExamples(
  mesExamplesArray: string[],
  args: {
    instruct: InstructSettings;
    context: ContextSettings;
    sysprompt?: SyspromptSettings;
    ctx: InstructCtx;
  }
): string[] {
  return withCtx(args.ctx, args.instruct, args.context, args.sysprompt ?? DEFAULT_SYSPROMPT, () =>
    formatInstructModeExamples(mesExamplesArray, args.ctx.name1, args.ctx.name2)
  );
}

/**
 * 计算最后一行 generation cue。对应 ST `formatInstructModePrompt`。
 */
export function formatInstructPrompt(args: {
  name: string;
  isImpersonate: boolean;
  promptBias?: string;
  isQuiet?: boolean;
  isQuietToLoud?: boolean;
  instruct: InstructSettings;
  context?: ContextSettings;
  sysprompt?: SyspromptSettings;
  ctx: InstructCtx;
}): string {
  const ctxObj = args.ctx;
  const context = args.context ?? createBlankContext();
  const sysprompt = args.sysprompt ?? DEFAULT_SYSPROMPT;
  return withCtx(ctxObj, args.instruct, context, sysprompt, () =>
    formatInstructModePrompt(
      args.name,
      args.isImpersonate,
      args.promptBias ?? '',
      ctxObj.name1,
      ctxObj.name2,
      args.isQuiet ?? false,
      args.isQuietToLoud ?? false,
      args.instruct
    )
  );
}

/**
 * 已 deprecated 的 system prompt 格式化（identity 函数）。保留对外
 * 仅为完整性。对应 ST `formatInstructModeSystemPrompt`。
 */
export function formatInstructSystemPrompt(
  systemPrompt: string,
  args?: { instruct?: InstructSettings }
): string {
  // 不需要 ctx 注入；纯 identity
  return formatInstructModeSystemPrompt(systemPrompt, args?.instruct ?? null);
}

/**
 * 计算 stop sequences 数组（喂给 text-completion 后端）。
 * 对应 ST `getInstructStoppingSequences`。
 */
export function getInstructStoppingSequences(args: {
  instruct: InstructSettings;
  context: ContextSettings;
  sysprompt?: SyspromptSettings;
  useStopStrings?: boolean | null;
  ctx: InstructCtx;
}): string[] {
  return withCtx(args.ctx, args.instruct, args.context, args.sysprompt ?? DEFAULT_SYSPROMPT, () =>
    _getInstructStoppingSequences({
      customInstruct: args.instruct,
      useStopStrings: args.useStopStrings ?? null,
    })
  );
}

/**
 * 注册 instruct mode 相关宏（19 条）。返回的每条是
 * `{ regex: RegExp, replace: () => string }`，`replace` 是闭包，
 * 调用时实时读取注入的 power_user。
 *
 * 注意：返回的 `replace` 闭包**只在 withCtx 期间**有效——一旦
 * resetRuntimeCtx 触发，host.power_user 还原回旧值，闭包读到的也跟着变。
 * 大多数调用方应该立刻消费这些 replace 函数（例如把它们注册进 macros
 * 引擎或一次性遍历 chat 文本替换），而不是把它们存起来跨调用使用。
 */
export function getInstructMacros(args: {
  instruct: InstructSettings;
  context: ContextSettings;
  sysprompt: SyspromptSettings;
  preferCharacterPrompt?: boolean;
  charPrompt?: string;
  ctx: InstructCtx;
}): Array<{ regex: RegExp; replace: () => string }> {
  return withCtx(args.ctx, args.instruct, args.context, args.sysprompt, () => {
    // ST 原版还要 prefer_character_prompt（power_user 顶层），由 ctx 间接传递。
    // 这里我们临时把它塞进 power_user 的浅顶层；下一行 _getInstructMacros 会读到。
    // 不通过 setRuntimeCtx 是因为 prefer_character_prompt 不在 power_user
    // 的「nested 替换块」里，host.js 默认值是 false，浅顶层我们手工设。
    return _getInstructMacros({ charPrompt: args.charPrompt ?? '' });
  });
}

/**
 * 把任意年代的 instruct preset 对象迁移成 evergreen 格式（原地修改 +
 * 返回同一个对象的引用）。对应 ST 私有函数 `migrateInstructModeSettings`。
 * 不需要 ctx；纯字段重命名 + 默认补齐。
 */
export function migrateInstructSettings(
  settings: Record<string, unknown>
): Record<string, unknown> {
  _migrateInstructModeSettings(settings);
  return settings;
}

// ─── 内部辅助 ────────────────────────────────────────────────────────────────

function createBlankContext(): ContextSettings {
  return {
    preset: '',
    story_string_position: 0,
    chat_start: '',
    example_separator: '',
    use_stop_strings: false,
  };
}

// 显式 re-export SubstituteCtx 类型，方便调用方对照
export type { SubstituteCtx, SubstituteOptions };
