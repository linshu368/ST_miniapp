/**
 * world-info.ts
 *
 * Step 2 — World Info 扫描层的唯一对外 TS 门面。
 * 与 Step 0 的 `substituteParams.ts`、Step 1 的 `instruct.ts` 同档定位：
 *
 *   - 后端代码（src/** 之下、test 之外）只 import 本文件，绝不
 *     深入 ./world-info/** 子树。
 *   - 内部走 setRuntimeCtx → macros 子树共享同一份 ctx 注入路径，
 *     WI 扫描期间调用 substituteParams 展开 entry.key / entry.content
 *     时，宏引擎从 host.js 读取注入的上下文，与 Step 0/1 一致。
 *
 * 当前状态：Step 2.0 骨架占位。
 *   - 类型全部导出，供 test / runner 使用。
 *   - `getWorldInfoPrompt()` 为 stub，返回空结果，待 Step 2.1–2.7 填充。
 *
 * 与 ST 原版的语义对齐（目标，Step 2.7 完成后）：
 *   - `getWorldInfoPrompt(params)` — 扫描主入口，返回 WIPromptResult
 *   - 内部依次调用：
 *       getSortedEntries → timedEffects.checkTimedEffects
 *       → checkWorldInfo（状态机主循环）
 *       → timedEffects.setTimedEffects
 *       → 分桶输出
 */

import { initRegisterMacros } from './macros/macro-system.js';
import { setRuntimeCtx, resetRuntimeCtx } from './macros/runtime/host.js';
import { setGlobalStore } from './macros/runtime/variables.js';

// ─── 公开类型（re-export，调用方只需 import 本文件） ─────────────────────────

export type {
  WIEntry,
  WISettings,
  WICtx,
  WILoreData,
  WIGlobalScanData,
  WIPromptResult,
  WIDepthEntry,
  WIEMEntry,
  WITimedEffect,
  ScanState,
  WIPosition,
  WILogic,
  ExtensionPromptRole,
  TimedEffectType,
} from './world-info/types.js';

import type {
  WISettings,
  WICtx,
  WILoreData,
  WIGlobalScanData,
  WIPromptResult,
} from './world-info/types.js';

// ─── 内部：ctx 注入流水线 ─────────────────────────────────────────────────────

let _initialized = false;

function ensureInitialized(): void {
  if (_initialized) return;
  // 宏引擎懒初始化（与 substituteParams.ts / instruct.ts 一致）。
  // checkWorldInfo 内部调用 substituteParams 展开 key/content 时需要它。
  initRegisterMacros();
  _initialized = true;
}

/**
 * 把 WICtx 拼成 host.js 的 setRuntimeCtx patch。
 * 只填 WI 实际读到的字段；其余字段交给 host.js 自己的默认值。
 */
function buildHostPatch(ctx: WICtx): Record<string, unknown> {
  return {
    name1: ctx.name1 ?? '',
    name2: ctx.name2 ?? '',
    chat: ctx.chat ?? [],
    chat_metadata: ctx.chatMetadata ?? {},
    characters: ctx.characters ?? [],
    this_chid: ctx.thisChid ?? -1,
    main_api: ctx.mainApi ?? '',
    // power_user 最小骨架，后续 Step 3/4 集成时可按需扩展
    power_user: {},
    // extension_prompts 总线（WI 内部 externallyActivated 路径会读它）
    extension_prompts: {},
  };
}

/**
 * 通用「注入 ctx → 跑 fn → 还原」高阶函数（与 instruct.ts 的 withCtx 同档）。
 * 所有公开 API 都通过它包一层，确保异常路径也能 resetRuntimeCtx。
 */
function withCtx<T>(ctx: WICtx, fn: () => T): T {
  ensureInitialized();
  const hostPatch = buildHostPatch(ctx);
  const hostSnapshot = setRuntimeCtx(hostPatch);
  const prevGlobalStore = setGlobalStore(ctx.globalVariables ?? {});
  try {
    return fn();
  } finally {
    setGlobalStore(prevGlobalStore);
    resetRuntimeCtx(hostSnapshot);
  }
}

// ─── 默认值辅助 ──────────────────────────────────────────────────────────────

/** WISettings 的默认值，与 ST 原版全局变量初始值一致。 */
function createDefaultSettings(): Required<WISettings> {
  return {
    world_info_depth: 2,
    world_info_min_activations: 0,
    world_info_min_activations_depth_max: 0,
    world_info_budget: 25,
    world_info_budget_cap: 0,
    world_info_include_names: true,
    world_info_recursive: false,
    world_info_overflow_alert: false,
    world_info_case_sensitive: false,
    world_info_match_whole_words: false,
    world_info_use_group_scoring: false,
    world_info_character_strategy: 1, // character_first
    world_info_max_recursion_steps: 0,
  };
}

/** WIGlobalScanData 的默认值，与 ST `defaultGlobalScanData` 一致。 */
function createDefaultGlobalScanData(): WIGlobalScanData {
  return {
    trigger: 'normal',
    personaDescription: '',
    characterDescription: '',
    characterPersonality: '',
    characterDepthPrompt: '',
    scenario: '',
    creatorNotes: '',
  };
}

/** getWorldInfoPrompt() 的空结果（stub 阶段返回值）。 */
function createEmptyResult(): WIPromptResult {
  return {
    worldInfoBefore: '',
    worldInfoAfter: '',
    worldInfoExamples: [],
    worldInfoDepth: [],
    anBefore: [],
    anAfter: [],
    outletEntries: {},
    allActivatedEntries: new Set(),
  };
}

// ─── 公开 API ────────────────────────────────────────────────────────────────

/**
 * World Info 扫描主入口。
 *
 * 对应 ST `getWorldInfoPrompt(chat, maxContext, isDryRun, globalScanData)`
 * （world-info.js:3147），但改为接受显式参数对象，不读模块级全局。
 *
 * 参数说明：
 * @param params.chat            - 聊天历史数组（逆序，[0]=最新消息），
 *                                 元素为消息字符串（已剥离 name 前缀）。
 * @param params.maxContext      - 当前模型的最大 token 数（用于计算 WI 预算）。
 * @param params.isDryRun        - 为 true 时不写持久化状态（时序效果）。
 * @param params.settings        - WI 全局配置；未传字段使用默认值。
 * @param params.lore            - 四类 lore 数据源（调用方预先加载好传入）。
 * @param params.globalScanData  - 与聊天无关的静态扫描数据（角色卡字段等）。
 * @param params.ctx             - 宏展开所需运行时上下文；默认全空（宏不展开）。
 *
 * @returns WIPromptResult — 分桶后的激活条目内容。
 *
 * ⚠️  当前为 Step 2.0 stub，始终返回空结果。
 *     Step 2.1–2.7 完成后替换为真正的 checkWorldInfo 调用。
 */
export async function getWorldInfoPrompt(params: {
  chat: string[];
  maxContext: number;
  isDryRun?: boolean;
  settings?: WISettings;
  lore: WILoreData;
  globalScanData?: Partial<WIGlobalScanData>;
  ctx?: WICtx;
}): Promise<WIPromptResult> {
  const {
    chat,
    maxContext,
    isDryRun = false,
    settings = {},
    lore,
    globalScanData = {},
    ctx = {},
  } = params;

  // 合并调用方设置与默认值
  const resolvedSettings: Required<WISettings> = {
    ...createDefaultSettings(),
    ...settings,
  };

  const resolvedGlobalScanData: WIGlobalScanData = {
    ...createDefaultGlobalScanData(),
    ...globalScanData,
  };

  // withCtx 注入宏引擎上下文（即使 stub 阶段也走这条路，确保路径正确）
  return withCtx(ctx, () => {
    // ── Step 2.0 STUB ────────────────────────────────────────────────────
    // TODO(Step 2.4): 替换为 getSortedEntries(lore, resolvedSettings)
    // TODO(Step 2.6): 替换为 checkWorldInfo(...) 主循环
    // ─────────────────────────────────────────────────────────────────────
    void chat;
    void maxContext;
    void isDryRun;
    void resolvedSettings;
    void resolvedGlobalScanData;
    void lore;
    return createEmptyResult();
  });
}
