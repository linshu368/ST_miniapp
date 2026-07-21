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
    message?: unknown;
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
    if (!isGenerationRequest(input)) return response;

    if (response.status === 402) {
      void notifyInsufficientBalance(response.clone(), state.server);
    } else if (response.ok) {
      void notifyWrappedInsufficientBalance(response.clone(), state.server);
    }
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
    const event = resolveInsufficientBalanceEvent(await response.json(), false);
    if (event) server.sendEvent('billing:insufficient', event);
  } catch {
    // Keep ST's native error handling authoritative when the response is malformed.
  }
}

async function notifyWrappedInsufficientBalance(
  response: Response,
  server: BridgeServer
): Promise<void> {
  try {
    const event = resolveInsufficientBalanceEvent(await response.json(), true);
    if (event) server.sendEvent('billing:insufficient', event);
  } catch {
    // Non-JSON successful responses are unrelated to billing.
  }
}

export function resolveInsufficientBalanceEvent(
  payload: unknown,
  allowWrappedResponse: boolean
): { creditsRequired: number; creditsAvailable: number } | null {
  const error =
    payload && typeof payload === 'object'
      ? (payload as InsufficientBalanceResponse).error
      : undefined;
  if (
    error?.type === 'insufficient_balance' &&
    typeof error.credits_required === 'number' &&
    typeof error.credits_available === 'number'
  ) {
    return {
      creditsRequired: error.credits_required,
      creditsAvailable: error.credits_available,
    };
  }

  if (
    allowWrappedResponse &&
    (error?.message === 'MiniApp Insufficient Credits' || error?.message === 'Payment Required')
  ) {
    return { creditsRequired: 0, creditsAvailable: 0 };
  }

  return null;
}
