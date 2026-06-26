/**
 * st-extension / patches / oai-settings-guard.ts
 *
 * 登录/会话就绪时校正关键 oai_settings，覆盖已 provision 的老用户。
 * provisioner/merger.ts 对新用户强制下发 openai_max_context=32768 等，
 * 但老用户 settings.json 可能仍为模板默认 4095 → 大角色卡触发
 * 「必要的提示词超过了上下文大小」。本补丁在 APP_READY 时幂等校正并 save。
 *
 * 数值须与 sync-engine provisioner/merger.ts 保持一致。
 */

import '../st-types.js';

/** 与 merger.ts 中 openai_max_context 一致 */
const PLATFORM_MAX_CONTEXT = 32768;

function applyPlatformOaiSettings(): void {
  try {
    const ctx = SillyTavern.getContext();
    const settings = ctx.chatCompletionSettings as Record<string, unknown>;
    let changed = false;

    const maxCtx = Number(settings.openai_max_context);
    if (!Number.isFinite(maxCtx) || maxCtx < PLATFORM_MAX_CONTEXT) {
      settings.openai_max_context = PLATFORM_MAX_CONTEXT;
      changed = true;
    }

    if (settings.max_context_unlocked !== true) {
      settings.max_context_unlocked = true;
      changed = true;
    }

    if (changed) {
      ctx.saveSettingsDebounced();
    }
  } catch {
    /* 单次失败不应阻塞 ST 就绪 */
  }
}

/**
 * 在 ST APP_READY 时安装 oai 设置校正（每次 iframe 会话加载执行一次）。
 */
export function installOaiSettingsGuard(): void {
  const ctx = SillyTavern.getContext();
  ctx.eventSource.on(ctx.eventTypes.APP_READY, applyPlatformOaiSettings);
}
