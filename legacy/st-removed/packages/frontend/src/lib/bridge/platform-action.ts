import type { ActionName, ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import { BridgeError } from '@miniapp/bridge-protocol';
import { getBridgeClient } from './singleton';

export async function platformAction<A extends ActionName>(
  action: A,
  payload: ActionPayloadMap[A]
): Promise<ActionResultMap[A]> {
  const client = getBridgeClient();

  if (!client.isActionSupported(action)) {
    throw new BridgeError('BRIDGE_CALL_ACTION_NOT_SUPPORTED', `Action not supported: ${action}`);
  }

  return client.sendAction(action, payload);
}
