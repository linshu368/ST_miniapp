/**
 * st-extension / patches / global-regex-safety-net.ts
 *
 * 架构铁律：vendor/sillytavern 只读，ST 交互从 extension 侧调整。
 *
 * 修复目标：模型输出中 <thinking> / <think> / <disclaimer> 等包装标签
 *   可能直接暴露给用户。各卡/预设虽自带清洗脚本，但存在漏配、授权失败、
 *   标签变体不匹配等缝隙。需要一张「平台级兜底网」，无论哪张卡、哪个预设，
 *   这些标签在展示层一律不可见。
 *
 * 修复方式：init + APP_READY + CHAT_CHANGED 时向 extension_settings.regex
 *   （全局正则数组）注入兜底脚本。全局正则无需授权、对所有卡/预设恒定生效。
 *   脚本仅影响 markdown 渲染（markdownOnly=true），不干预发送给模型的 prompt。
 *   使用固定 id 防止重复注入。不调用 saveSettingsDebounced，纯内存态注入。
 *
 * 范围：仅覆盖 <thinking>/<think> 和 <disclaimer>。
 *   <UpdateVariable> / <Analysis> / <JSONPatch> 等留给各卡/预设自有脚本处理
 *   （这些标签常被卡脚本美化为可交互 UI 组件，全局删除会误伤）。
 */

import '../st-types.js';

/** regex_placement.AI_OUTPUT（见 vendor regex/engine.js） */
const AI_OUTPUT = 2;

/** substitute_find_regex.NONE */
const SUBSTITUTE_NONE = 0;

interface RegexScriptShape {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  placement: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  substituteRegex: number;
  minDepth: null;
  maxDepth: null;
}

const SAFETY_NET_SCRIPTS: readonly RegexScriptShape[] = [
  {
    id: 'platform-safety-net-thinking',
    scriptName: '[平台兜底] 隐藏思维链',
    findRegex: '/<think(?:ing)?>[\\s\\S]*?<\\/think(?:ing)?>/gi',
    replaceString: '',
    trimStrings: [],
    placement: [AI_OUTPUT],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: SUBSTITUTE_NONE,
    minDepth: null,
    maxDepth: null,
  },
  {
    id: 'platform-safety-net-disclaimer',
    scriptName: '[平台兜底] 隐藏免责声明',
    findRegex: '/<disclaimer>[\\s\\S]*?<\\/disclaimer>/gi',
    replaceString: '',
    trimStrings: [],
    placement: [AI_OUTPUT],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: SUBSTITUTE_NONE,
    minDepth: null,
    maxDepth: null,
  },
];

/**
 * 向 extension_settings.regex 注入兜底脚本（幂等：已存在则跳过）。
 */
function injectSafetyNetScripts(): void {
  try {
    const settings = SillyTavern.getContext().extensionSettings;
    const regex = settings.regex;
    if (!Array.isArray(regex)) return;

    for (const script of SAFETY_NET_SCRIPTS) {
      if (!regex.some((s: Record<string, unknown>) => s.id === script.id)) {
        regex.push({ ...script });
      }
    }
  } catch {
    /* extension_settings 尚未就绪时忽略，APP_READY 会再注入 */
  }
}

/**
 * 安装全局正则兜底网。
 * init 时立即注入；APP_READY 后 settings 加载完毕再兜底一次；
 * CHAT_CHANGED(makeFirst) 抢在 ST regex 扩展重载脚本列表之前确保兜底脚本在位。
 */
export function installGlobalRegexSafetyNet(): void {
  injectSafetyNetScripts();
  const ctx = SillyTavern.getContext();
  ctx.eventSource.on(ctx.eventTypes.APP_READY, injectSafetyNetScripts);
  ctx.eventSource.makeFirst(ctx.eventTypes.CHAT_CHANGED, injectSafetyNetScripts);
}
