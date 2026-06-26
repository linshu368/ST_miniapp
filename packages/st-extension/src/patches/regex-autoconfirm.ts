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
 *     点「确定」即 allowScopedScripts(character)（把 avatar 加入该数组）。
 *
 * 修复方式：用 eventSource.makeFirst 注册一个「先于」ST regex 处理器执行的
 *   CHAT_CHANGED 监听，提前把当前角色 avatar 写入 character_allowed_regex。
 *   这样 ST 处理器运行时 isScopedScriptsAllowed 已为 true → 跳过弹窗，
 *   且正则按「确定」语义启用。makeFirst 保证抢在 ST 处理器之前，规避时序竞态，
 *   覆盖所有入口（bridge selectCharacter / 整页刷新自动载入 / 切换聊天）。
 */

import '../st-types.js';

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
    }
  } catch {
    /* 单次失败不应影响聊天流程 */
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
