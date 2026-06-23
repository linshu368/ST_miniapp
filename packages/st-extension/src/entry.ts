import { BRIDGE_CHANNEL, PROTOCOL_VERSION } from '@miniapp/bridge-protocol';

const TAG = `[${BRIDGE_CHANNEL}]`;

function init(): void {
  console.log(`${TAG} Extension loaded — protocol v${PROTOCOL_VERSION}, build ${__BUILD_ID__}`);
}

declare const __BUILD_ID__: string;

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
