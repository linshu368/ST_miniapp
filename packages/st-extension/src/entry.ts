import { createBridgeServer } from './bridge-server.js';
import { initHandshake } from './handshake.js';
import { registerForwarders } from './forwarders/index.js';
import { installAutocompleteGuard } from './patches/autocomplete-guard.js';
import { installTabsBaseGuard } from './patches/tabs-base-guard.js';
import { installRegexAutoConfirm } from './patches/regex-autoconfirm.js';
import { installPresetRegexAutoConfirm } from './patches/preset-regex-autoconfirm.js';
import { installWorldbookAutoImport } from './patches/worldbook-autoimport.js';
import { installOaiSettingsGuard } from './patches/oai-settings-guard.js';
import { installTavernHelperGuard } from './patches/tavern-helper-guard.js';
import { installScriptPopupAutoCancel } from './patches/script-popup-autocancel.js';
import {
  installNativeUiHide,
  installPresetUiHide,
  installEmptyDetailsHide,
} from './patches/native-ui-hide.js';
import { installLlmMetadataInject } from './patches/llm-metadata-inject.js';
import { installReasoningAutoParse } from './patches/reasoning-auto-parse.js';
import { installGlobalRegexSafetyNet } from './patches/global-regex-safety-net.js';
import { installCharTokenCounterSuppress } from './patches/char-token-counter-suppress.js';
import { installWelcomeScreenSuppress } from './patches/welcome-screen-suppress.js';
import { installBillingErrorBridge } from './patches/billing-error-bridge.js';
import { stTiming } from './debug-timing.js'; // [iframe-timing] TEMP DEBUG
import { installBootTimingProbes } from './debug-boot-probes.js'; // [iframe-timing] TEMP DEBUG
import { installBootWaterfallProbe } from './debug-boot-waterfall.js'; // [iframe-timing] TEMP DEBUG
import {
  handleSelectCharacter,
  handleOpenChat,
  handleNewChat,
  handleRenameChat,
  handleDeleteChat,
  handleChangeModel,
  handleGetReadyState,
  setServerRef,
} from './handlers/index.js';

declare const __BUILD_ID__: string;
declare const __ST_COMMIT__: string;

function init(): void {
  stTiming('st_init_start'); // [iframe-timing] TEMP DEBUG
  installBootTimingProbes(); // [iframe-timing] TEMP DEBUG: 订阅 ST boot 生命周期事件
  installBootWaterfallProbe(); // [iframe-timing] TEMP DEBUG: APP_READY 时收割资源瀑布+长任务
  // 架构铁律：vendor 只读，ST resize 报错从 extension 侧修复（见 patches/autocomplete-guard）
  installAutocompleteGuard();
  // 架构铁律：vendor 只读，<base href="/"> + /tavern 子路径导致 jQuery UI Tabs 误把本地锚点
  // 当远程 URL AJAX 加载整页、注入重复 ST DOM（#sheld 0×0、发送按钮失效），从 extension 侧修复。
  installTabsBaseGuard();
  // 进入对话时「是否启用角色内置正则」确认弹窗：平台角色均可信，自动按「确定」启用，用户无感。
  installRegexAutoConfirm();
  // 预设内置正则（如剥离 <thinking>/<disclaimer> 的清洗脚本）默认不生效：平台预设由服务端烘入、
  // 不走 ST 下拉框切换，原生「是否启用预设正则」授权流程从不触发。自动授权当前预设，等价按「确定」。
  installPresetRegexAutoConfirm();
  // 进入对话时「是否导入角色内置世界书」确认弹窗：平台角色均可信，自动按「Yes」静默导入并链接，用户无感。
  installWorldbookAutoImport();
  // 老用户 settings.json 可能仍为 openai_max_context=4095；APP_READY 时幂等校正为平台值。
  installOaiSettingsGuard();
  // 第三方扩展「酒馆助手」TH-optimize 默认全开：maximize_preset_context_length 把上下文顶到 2M、
  // force_recommended_worldbook_global_settings 静默改写全局 WI 设置。源头关闭这两项并兜底夹紧，
  // 保持平台 32768 与既定设置权威（渲染器不动，角色脚本弹窗见 script-popup-autocancel）。
  installTavernHelperGuard();
  // 酒馆助手「角色卡含嵌入式脚本，是否启用」Vue 弹窗：平台默认关闭角色脚本，自动按「取消」跳过。
  installScriptPopupAutoCancel();
  // 隐藏 ST 底部输入栏左侧原生按钮（#options_button / #extensionsMenuButton），由平台壳 ChatToolsMenu 替代。
  installNativeUiHide();
  // 隐藏 ST 原生「AI Response Configuration / 对话补全预设」抽屉：平台不开放用户改预设，始终隐藏。
  installPresetUiHide();
  // 部分卡 scoped 正则剥离 <UpdateVariable> 后残留空 <details> 壳（encode_tags=false 时渲染为空「详情」）。
  installEmptyDetailsHide();
  // 每次 LLM 请求前注入 X-ST-Character-Id / X-ST-Preset-Id header，供 llm-proxy 落 chat_history。
  installLlmMetadataInject();
  // ST 内置推理解析器默认关闭，模型 <think> 思维链会直接暴露。强制开启作为全局安全网。
  installReasoningAutoParse();
  // 平台级全局正则兜底：无论哪张卡、哪个预设，<thinking>/<think>/<disclaimer> 在展示层一律删除。
  // 全局正则无需授权、恒定生效，弥补各卡/预设脚本漏配或授权失败的缝隙。
  installGlobalRegexSafetyNet();
  // 切角色关键路径上 ST 给隐藏的角色编辑面板逐字段远程算 token（~10 次串行 RTT），
  // 移除 data-token-counter 属性使其零调用（见 patches/char-token-counter-suppress）。
  installCharTokenCounterSuppress();
  // 摘除 ST 原生欢迎屏在 APP_READY 的渲染（冷启动优化）：平台冷启动期 iframe 隐藏、
  // 点卡后 forceNewChat 覆盖，欢迎屏从不可见却在 boot 收尾串行拉 chats/recent + 渲染，
  // 且延后 bridge ready 握手（见 patches/welcome-screen-suppress）。
  installWelcomeScreenSuppress();

  const server = createBridgeServer('*');
  server.start();
  installBillingErrorBridge(server);

  // Register action handlers
  server.registerHandler('selectCharacter', (p) => handleSelectCharacter(p as any));
  server.registerHandler('openChat', (p) => handleOpenChat(p as any));
  server.registerHandler('newChat', () => handleNewChat());
  server.registerHandler('renameChat', (p) => handleRenameChat(p as any));
  server.registerHandler('deleteChat', (p) => handleDeleteChat(p as any));
  server.registerHandler('changeModel', (p) => handleChangeModel(p as any));
  server.registerHandler('getReadyState', () => handleGetReadyState());

  // Wire getReadyState handler to server reference
  setServerRef(server);

  initHandshake(server, {
    buildId: __BUILD_ID__,
    stCommit: __ST_COMMIT__,
  });

  registerForwarders(server);

  stTiming('st_init_done'); // [iframe-timing] TEMP DEBUG
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
