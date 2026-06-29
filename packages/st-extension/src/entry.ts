import { createBridgeServer } from './bridge-server.js';
import { initHandshake } from './handshake.js';
import { registerForwarders } from './forwarders/index.js';
import { installAutocompleteGuard } from './patches/autocomplete-guard.js';
import { installTabsBaseGuard } from './patches/tabs-base-guard.js';
import { installRegexAutoConfirm } from './patches/regex-autoconfirm.js';
import { installWorldbookAutoImport } from './patches/worldbook-autoimport.js';
import { installOaiSettingsGuard } from './patches/oai-settings-guard.js';
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
  // 架构铁律：vendor 只读，ST resize 报错从 extension 侧修复（见 patches/autocomplete-guard）
  installAutocompleteGuard();
  // 架构铁律：vendor 只读，<base href="/"> + /tavern 子路径导致 jQuery UI Tabs 误把本地锚点
  // 当远程 URL AJAX 加载整页、注入重复 ST DOM（#sheld 0×0、发送按钮失效），从 extension 侧修复。
  installTabsBaseGuard();
  // 进入对话时「是否启用角色内置正则」确认弹窗：平台角色均可信，自动按「确定」启用，用户无感。
  installRegexAutoConfirm();
  // 进入对话时「是否导入角色内置世界书」确认弹窗：平台角色均可信，自动按「Yes」静默导入并链接，用户无感。
  installWorldbookAutoImport();
  // 老用户 settings.json 可能仍为 openai_max_context=4095；APP_READY 时幂等校正为平台值。
  installOaiSettingsGuard();

  const server = createBridgeServer('*');
  server.start();

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
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
