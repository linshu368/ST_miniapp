import type { BridgeServer } from '../bridge-server.js';

const GENERATE_PATH = '/api/backends/chat-completions/generate';
const BRIDGE_STATE_KEY = '__miniappBillingErrorBridgeState__';

type BillingErrorBridgeState = {
  server: BridgeServer;
};

type BillingErrorBridgeWindow = Window &
  typeof globalThis & {
    [BRIDGE_STATE_KEY]?: BillingErrorBridgeState;
  };

type InsufficientBalanceResponse = {
  error?: {
    type?: unknown;
    credits_required?: unknown;
    credits_available?: unknown;
  };
};

/**
 * Observe ST's generation request without consuming its response body. For streaming requests,
 * ST forwards the llm-proxy 402 status/body unchanged, so the platform shell can navigate to the
 * recharge flow while ST completes its normal generation-error cleanup.
 */
export function installBillingErrorBridge(server: BridgeServer): void {
  const bridgeWindow = window as BillingErrorBridgeWindow;
  const installedState = bridgeWindow[BRIDGE_STATE_KEY];
  if (installedState) {
    installedState.server = server;
    return;
  }

  const state: BillingErrorBridgeState = { server };
  bridgeWindow[BRIDGE_STATE_KEY] = state;
  const originalFetch = bridgeWindow.fetch.bind(bridgeWindow);

  bridgeWindow.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await originalFetch(input, init);
    if (response.status !== 402 || !isGenerationRequest(input)) return response;

    void notifyInsufficientBalance(response.clone(), state.server);
    return response;
  };
}

function isGenerationRequest(input: RequestInfo | URL): boolean {
  const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;

  try {
    return new URL(rawUrl, window.location.origin).pathname === GENERATE_PATH;
  } catch {
    return false;
  }
}

async function notifyInsufficientBalance(response: Response, server: BridgeServer): Promise<void> {
  try {
    const payload = (await response.json()) as InsufficientBalanceResponse;
    const error = payload.error;
    if (
      error?.type !== 'insufficient_balance' ||
      typeof error.credits_required !== 'number' ||
      typeof error.credits_available !== 'number'
    ) {
      return;
    }

    server.sendEvent('billing:insufficient', {
      creditsRequired: error.credits_required,
      creditsAvailable: error.credits_available,
    });
  } catch {
    // Keep ST's native error handling authoritative when the response is malformed.
  }
}
