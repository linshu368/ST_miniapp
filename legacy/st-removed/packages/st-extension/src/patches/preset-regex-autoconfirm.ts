/**
 * st-extension / patches / preset-regex-autoconfirm.ts
 *
 * 架构铁律：vendor/sillytavern 只读，ST 交互从 extension 侧调整。
 *
 * 修复目标：平台预设（platform_presets）内置的「预设级正则」(preset-scoped regex)
 *   从未生效。依赖它的输出清洗——例如剥离 <thinking> / <disclaimer> 等包装标签——
 *   完全失灵，模型思维链与免责声明原样暴露给用户。
 *
 * ST 行为（scripts/extensions/regex/engine.js getScriptsByType 的 PRESET 分支）：
 *   预设内置正则只有当 extension_settings.preset_allowed_regex[apiId] 含「当前预设名」时，
 *   才会被 getRegexedString({ allowedOnly: true }) 取用；否则整段被跳过。
 *   原生授权路径是 PRESET_CHANGED → checkPresetEmbeddedRegexScripts() 弹「此预设含内置
 *   正则，是否启用？」确认框，点「确定」后 allowPresetScripts() 写入该数组。
 *
 * 平台为何失效：预设由 provisioner 服务端烘进 oai_settings（不经 ST 下拉框切换），
 *   PRESET_CHANGED 流程根本不触发；预设 UI 又被 native-ui-hide 隐藏，用户无从确认。
 *   此前只有 character（scoped）正则的自动授权补丁（regex-autoconfirm.ts），没有 preset 对应物。
 *
 * 修复方式（对齐 regex-autoconfirm 的两道防线）：
 *   1) 事件兜底 allowCurrentPresetRegex — APP_READY / CHAT_CHANGED / OAI_PRESET_CHANGED_AFTER
 *      时为当前预设预授权（等价于原生「确定」）。若为新增授权且已有对话，延迟触发
 *      reloadCurrentChat 使已渲染消息重新应用预设正则。
 *   2) preAllowPresetRegex() — 供 handleSelectCharacter 在 selectCharacterById 之前预写入，
 *      使 getChatResult → printMessages 首次渲染即应用预设正则，规避 CHAT_CHANGED 时序差。
 */

import '../st-types.js';

interface PresetRegexTarget {
  apiId: string;
  name: string;
}

/**
 * 解析「当前预设」的授权目标：仅当该预设确实含内置正则脚本时才返回，
 * 避免给无正则的预设写入无意义的允许项。
 */
function currentPresetRegexTarget(): PresetRegexTarget | null {
  const pm = SillyTavern.getContext().getPresetManager();
  if (!pm) return null;

  const apiId = pm.apiId;
  const name = pm.getSelectedPresetName();
  if (!apiId || !name) return null;

  const scripts = pm.readPresetExtensionField({ path: 'regex_scripts' });
  if (!Array.isArray(scripts) || scripts.length === 0) return null;

  return { apiId, name };
}

/**
 * 把预设名写入 preset_allowed_regex[apiId]。
 * @returns 本次是否为「新增」授权（用于决定是否需要 reload）。
 */
function addToAllowList(apiId: string, name: string): boolean {
  const settings = SillyTavern.getContext().extensionSettings;
  if (!settings.preset_allowed_regex || typeof settings.preset_allowed_regex !== 'object') {
    settings.preset_allowed_regex = {};
  }
  const map = settings.preset_allowed_regex;
  if (!Array.isArray(map[apiId])) {
    map[apiId] = [];
  }
  if (!map[apiId].includes(name)) {
    map[apiId].push(name);
    return true;
  }
  return false;
}

/**
 * 供 handleSelectCharacter 在 selectCharacterById 之前调用：best-effort 预写入，不 reload、
 * 不主动 save（handleSelectCharacter 末尾会统一 saveSettingsDebounced）。
 * 这样首次 printMessages 渲染即可应用预设正则，无需等 CHAT_CHANGED 再 reload。
 */
export function preAllowPresetRegex(): void {
  try {
    const target = currentPresetRegexTarget();
    if (!target) return;
    addToAllowList(target.apiId, target.name);
  } catch {
    /* best-effort */
  }
}

/**
 * 事件回调：为当前预设预授权。若为新增授权，持久化并（在已有对话时）延迟 reload，
 * 使已渲染消息重新应用预设正则。第二次事件时预设已在数组中，不再 reload → 无循环。
 */
function allowCurrentPresetRegex(): void {
  try {
    const target = currentPresetRegexTarget();
    if (!target) return;

    if (addToAllowList(target.apiId, target.name)) {
      const ctx = SillyTavern.getContext();
      ctx.saveSettingsDebounced();
      if (ctx.getCurrentChatId()) {
        setTimeout(() => void ctx.reloadCurrentChat(), 0);
      }
    }
  } catch {
    /* 单次失败不应影响聊天流程 */
  }
}

/**
 * 安装预设内置正则「自动确定」补丁。
 * makeFirst(CHAT_CHANGED) 抢在 ST regex 扩展的 CHAT_CHANGED 处理器之前；APP_READY 兜底
 * 首屏、OAI_PRESET_CHANGED_AFTER 兜底运行中切换预设。扩展初始化时预设可能已就绪，立即补一次。
 */
export function installPresetRegexAutoConfirm(): void {
  const ctx = SillyTavern.getContext();
  ctx.eventSource.makeFirst(ctx.eventTypes.CHAT_CHANGED, allowCurrentPresetRegex);
  ctx.eventSource.on(ctx.eventTypes.APP_READY, allowCurrentPresetRegex);
  ctx.eventSource.on(ctx.eventTypes.OAI_PRESET_CHANGED_AFTER, allowCurrentPresetRegex);
  allowCurrentPresetRegex();
}
