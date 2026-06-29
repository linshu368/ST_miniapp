/**
 * st-extension / patches / tavern-helper-guard.ts
 *
 * 架构铁律：vendor/sillytavern 只读，第三方扩展行为从 extension 侧调和。
 *
 * 背景：第三方扩展「酒馆助手」(JS-Slash-Runner) 的 TH-optimize 选项**默认全部开启**
 *   （已核实 src/type/settings.ts 的 zod `default(true)`）。本补丁只处理与平台既定设置
 *   冲突、且「静默覆盖平台行为」的两项；不碰渲染/脚本（见下「不处理」）。
 *
 *   1) `optimize.maximize_preset_context_length`（默认 true，
 *      src/panel/optimize/maximize_preset_context_length/index.ts）：
 *      把 `oai_settings.openai_max_context` 顶到 **2_000_000**、`max_context_unlocked=true`，
 *      并在 `SETTINGS_UPDATED` + `OAI_PRESET_CHANGED_AFTER`（切模型/切预设）反复重置。
 *      与本平台 `oai-settings-guard`(#4) / provisioner merger 约定的 **32768** 直接冲突，
 *      会把单次上下文撑到 2M → token 成本暴涨。
 *   2) `optimize.force_recommended_worldbook_global_settings`（默认 true，
 *      src/panel/optimize/force_recommended_worldbook_global_settings/index.ts）：
 *      经 setLorebookSettings 静默改写 ST **全局**世界书引擎设置
 *      （`context_percentage`=世界书可占 100% 上下文预算、scan_depth=2、recursive=true 等）。
 *      评估：与 `worldbook-autoimport`(#7) **无直接字段冲突**（#7 只写角色的 extensions.world =
 *      「链接哪本书」，本项改「全局 WI 引擎怎么扫描/预算」）；且 merger.ts 未设任何 WI 全局项。
 *      但它仍是「扩展静默覆盖平台未约定的全局行为」+ context_percentage=100 的成本风险，
 *      按「扩展不得静默覆盖平台设置」原则一并关闭。
 *
 * 处理（决策 3a：关闭上述两项，保持平台权威）：
 *   1) 源头关闭：尽早把这两个 optimize flag 置 false 写入 extension_settings。
 *      miniapp-bridge loading_order=1，早于酒馆助手(loading_order=100) 的 pinia store 首次读取
 *      （其 store 在 jQuery ready 里 createApp().mount() 时才 getSettings）。酒馆助手 zod 解析
 *      读到 false → 其 watchImmediate(enabled=false) 永不触发，不会改 oai/WI 设置。
 *   2) 兜底夹紧（仅 maximize）：若因任何时序竞态仍把 openai_max_context 设成酒馆助手的魔数
 *      2_000_000，在 APP_READY / OAI_PRESET_CHANGED_AFTER / CHATCOMPLETION_MODEL_CHANGED 时夹回
 *      32768（只针对恰为 2_000_000，不干扰其它合法大上下文）。
 *      —— `oai-settings-guard` 只「抬升」(< 32768 才改)、不会把 2M「降」回来，故需独立夹紧。
 *      WI 全局设置无魔数/无逐轮重置，源头关闭即可，无需夹紧。
 *
 * 不处理（按决策 2，留作【待产品/负责人对齐项】，见 docs/st-extension-patches.md §8）：
 *   - **渲染器 Renderer**（「启用渲染器」全局开关）：把消息里的 ```html 渲染成富界面，是核心
 *     体验，**本身不调用大模型、不扣费**；默认常开，**不动**。
 *   - **角色脚本启用确认框**（其自有 Vue 弹窗，gate `script.enabled.characters`）：是否自动启用
 *     角色脚本、是否承担「渲染 iframe 内联脚本 / 角色脚本」自发起生成的额外成本 → 交产品对齐，
 *     本轮**不做** auto-confirm/auto-cancel，保留原生弹窗（仅验证用）。
 */

import '../st-types.js';

/** 与 oai-settings-guard / merger.ts 中 openai_max_context 一致 */
const PLATFORM_MAX_CONTEXT = 32768;
/** 酒馆助手 maximize_preset_context_length 用的魔数（其 MAX_CONTEXT 常量） */
const TH_MAXIMIZE_SENTINEL = 2_000_000;

/** 源头关闭与平台冲突的 optimize 开关（运行时写入 extension_settings，早于酒馆助手 store 读取）。 */
function disableConflictingOptimize(): void {
  try {
    const settings = SillyTavern.getContext().extensionSettings;
    if (!settings.tavern_helper) settings.tavern_helper = {};
    if (!settings.tavern_helper.optimize) settings.tavern_helper.optimize = {};
    // 与平台 32768 冲突：会把 openai_max_context 顶到 2M
    settings.tavern_helper.optimize.maximize_preset_context_length = false;
    // 静默改写全局 WI 引擎设置（context_percentage=100 等），按「不得静默覆盖」原则关闭
    settings.tavern_helper.optimize.force_recommended_worldbook_global_settings = false;
  } catch {
    /* 酒馆助手未安装 / settings 未就绪时忽略 */
  }
}

/** 兜底：若 openai_max_context 被酒馆助手顶到 2_000_000，夹回平台 32768。 */
function clampMaximizedContext(): void {
  try {
    const ctx = SillyTavern.getContext();
    const settings = ctx.chatCompletionSettings as Record<string, unknown>;
    if (Number(settings.openai_max_context) === TH_MAXIMIZE_SENTINEL) {
      settings.openai_max_context = PLATFORM_MAX_CONTEXT;
      ctx.saveSettingsDebounced();
    }
  } catch {
    /* 单次失败不应阻塞 ST 就绪 */
  }
}

/**
 * 安装酒馆助手兼容护栏。
 * 立即源头关闭冲突 optimize；并在关键事件上兜底夹紧上下文。
 */
export function installTavernHelperGuard(): void {
  // 立即执行：抢在酒馆助手 store 首次 getSettings 之前（依赖 loading_order 1 < 100）
  disableConflictingOptimize();

  const ctx = SillyTavern.getContext();
  ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
    disableConflictingOptimize();
    clampMaximizedContext();
  });
  ctx.eventSource.on(ctx.eventTypes.OAI_PRESET_CHANGED_AFTER, clampMaximizedContext);
  ctx.eventSource.on(ctx.eventTypes.CHATCOMPLETION_MODEL_CHANGED, clampMaximizedContext);
}
