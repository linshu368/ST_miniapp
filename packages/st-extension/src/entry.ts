import { createBridgeServer } from './bridge-server.js';
import { initHandshake } from './handshake.js';
import { registerForwarders } from './forwarders/index.js';
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
