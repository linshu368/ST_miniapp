/**
 * st-extension / patches / regex-autoconfirm.ts
 *
 * 架构铁律：vendor/sillytavern 只读，ST 交互从 extension 侧调整。
 *
 * 修复目标：进入对话时弹出的「此角色含有内置正则。你想要启用它们吗？」确认弹窗。
 *   平台所有角色卡均为运营可信内容，用户不应感知该弹窗 —— 等价于自动点「确定」。
 *
 * ST 行为（scripts/extensions/regex/index.js）：
 *   CHAT_CHANGED → checkCharEmbeddedRegexScripts()：
 *     若当前角色含 SCOPED 正则脚本且 avatar 不在
 *     `extension_settings.character_allowed_regex` 中，则弹 CONFIRM 弹窗；
 *     点「确定」即 allowScopedScripts(character)（把 avatar 加入该数组）
 *     并 reloadCurrentChat() 重新渲染消息使正则生效。
 *
 * 修复方式（两道防线）：
 *   1) makeFirst(CHAT_CHANGED) — 抢在 ST regex 处理器之前将 avatar 写入
 *      character_allowed_regex，使 isScopedScriptsAllowed 为 true → 弹窗跳过。
 *      若此次为新增授权，延迟触发 reloadCurrentChat 使已渲染消息应用正则
 *      （等价于原生「确定」后的 reloadCurrentChat）。
 *   2) preAllowCharacterRegex(avatar) — 供 handleSelectCharacter 在调用
 *      selectCharacterById 之前预写入 avatar，使 getChatResult → printMessages
 *      首次渲染即应用 scoped regex，规避 CHAT_CHANGED 时序差。
 */

import '../st-types.js';

/**
 * 在 CHAT_CHANGED 中为当前角色预授权 scoped regex。
 * 若为首次授权，延迟触发 reloadCurrentChat 重新渲染消息。
 */
function allowCurrentCharacterRegex(): void {
  try {
    const ctx = SillyTavern.getContext();
    const chid = ctx.characterId;
    if (chid === undefined) return;

    const avatar = ctx.characters[chid]?.avatar;
    if (!avatar) return;

    const settings = ctx.extensionSettings;
    if (!Array.isArray(settings.character_allowed_regex)) {
      settings.character_allowed_regex = [];
    }
    if (!settings.character_allowed_regex.includes(avatar)) {
      settings.character_allowed_regex.push(avatar);
      ctx.saveSettingsDebounced();
      // printMessages 在 CHAT_CHANGED 之前已执行，此时消息未经正则处理。
      // 延迟 reload 使已渲染消息重新应用 scoped regex。
      // 第二次 CHAT_CHANGED 时 avatar 已在数组中，不会再 reload → 无循环。
      setTimeout(() => void ctx.reloadCurrentChat(), 0);
    }
  } catch {
    /* 单次失败不应影响聊天流程 */
  }
}

/**
 * 供 handleSelectCharacter 在 selectCharacterById 之前调用，
 * 将目标角色 avatar 预写入 character_allowed_regex。
 * 这样 getChatResult → printMessages 首次渲染即可应用 scoped regex，
 * 无需等 CHAT_CHANGED 再 reload。
 */
export function preAllowCharacterRegex(avatar: string): void {
  try {
    const settings = SillyTavern.getContext().extensionSettings;
    if (!Array.isArray(settings.character_allowed_regex)) {
      settings.character_allowed_regex = [];
    }
    if (!settings.character_allowed_regex.includes(avatar)) {
      settings.character_allowed_regex.push(avatar);
    }
  } catch {
    /* best-effort */
  }
}

/**
 * 安装角色内置正则「自动确定」补丁。
 * 通过 makeFirst 抢在 ST regex 扩展的 CHAT_CHANGED 处理器之前执行。
 */
export function installRegexAutoConfirm(): void {
  const ctx = SillyTavern.getContext();
  ctx.eventSource.makeFirst(ctx.eventTypes.CHAT_CHANGED, allowCurrentCharacterRegex);
  // 扩展初始化时角色可能已选中（整页刷新场景），立即补一次
  allowCurrentCharacterRegex();
}
