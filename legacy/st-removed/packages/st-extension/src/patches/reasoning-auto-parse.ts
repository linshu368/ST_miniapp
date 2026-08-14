/**
 * st-extension / patches / reasoning-auto-parse.ts
 *
 * 架构铁律：vendor/sillytavern 只读，ST 交互从 extension 侧调整。
 *
 * 修复目标：ST 内置推理解析器默认关闭（power_user.reasoning.auto_parse = false），
 *   当模型返回 <think>...</think> 等思维链标签时，内容会直接暴露给用户。
 *   角色卡内置正则可以剥离非标准格式的思维链，但无法覆盖所有情况；
 *   且正则需要每张卡单独配置，漏配即泄露。
 *
 * 修复方式：init + APP_READY 时强制 auto_parse = true，
 *   作为全局安全网兜底所有 <think> 格式的思维链。
 *   仅运行时内存覆写，不持久化（不调用 saveSettingsDebounced），
 *   避免覆写用户在 ST 原生面板的手动配置。
 */

import '../st-types.js';

function enableReasoningAutoParse(): void {
  try {
    const pu = SillyTavern.getContext().powerUserSettings;
    const reasoning = pu.reasoning as Record<string, unknown> | undefined;
    if (reasoning) {
      reasoning.auto_parse = true;
      reasoning.auto_expand = true;
      if (typeof reasoning.prefix !== 'string' || !reasoning.prefix) reasoning.prefix = '<think>';
      if (typeof reasoning.suffix !== 'string' || !reasoning.suffix) reasoning.suffix = '</think>';
    }
  } catch {
    /* power_user 尚未就绪时忽略，APP_READY 会再设一次 */
  }
}

/**
 * 安装推理解析器「自动开启」补丁。
 * init 时立即设一次，APP_READY 后 settings 加载完毕再兜底一次。
 */
export function installReasoningAutoParse(): void {
  enableReasoningAutoParse();
  const ctx = SillyTavern.getContext();
  ctx.eventSource.on(ctx.eventTypes.APP_READY, enableReasoningAutoParse);
  ctx.eventSource.on(ctx.eventTypes.SETTINGS_UPDATED, () => {
    // Run after other extension listeners that may restore incompatible defaults.
    queueMicrotask(enableReasoningAutoParse);
  });
}
