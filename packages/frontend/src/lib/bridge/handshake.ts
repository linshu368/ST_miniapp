import type { HandshakeMessage, HandshakeMeta } from '@miniapp/bridge-protocol';
import { PROTOCOL_VERSION, BridgeError } from '@miniapp/bridge-protocol';
import type { BridgeStateMachine } from './state-machine';
import type { RequestBuffer, BufferedRequest } from './buffer';

export type HandshakeState = {
  supportedActions: string[];
  supportedEvents: string[];
  boundUserId: string | null;
  meta: HandshakeMeta | null;
};

export function createHandshakeState(): HandshakeState {
  return {
    supportedActions: [],
    supportedEvents: [],
    boundUserId: null,
    meta: null,
  };
}

export type HandleHandshakeOptions = {
  message: HandshakeMessage;
  stateMachine: BridgeStateMachine;
  handshakeState: HandshakeState;
  buffer: RequestBuffer;
  expectedUserId: string | null;
  sendBuffered: (requests: BufferedRequest[]) => void;
};

export function handleHandshakeMessage(opts: HandleHandshakeOptions): void {
  const { message, stateMachine, handshakeState, buffer, expectedUserId, sendBuffered } = opts;

  if (message.phase === 'handshake') {
    if (message.meta == null) {
      throw new BridgeError(
        'BRIDGE_PROTOCOL_PAYLOAD_SCHEMA_INVALID',
        'Handshake message missing meta'
      );
    }

    const meta = message.meta;

    if (message.protocolVersion !== PROTOCOL_VERSION) {
      throw new BridgeError(
        'BRIDGE_PROTOCOL_VERSION_MISMATCH',
        `Expected protocol version ${PROTOCOL_VERSION}, got ${message.protocolVersion}`
      );
    }

    if (meta.boundUserId == null) {
      throw new BridgeError(
        'BRIDGE_HANDSHAKE_USER_MISSING',
        'ST extension did not report a bound userId'
      );
    }

    if (expectedUserId != null && meta.boundUserId !== expectedUserId) {
      throw new BridgeError(
        'BRIDGE_HANDSHAKE_USER_MISMATCH',
        `Expected userId "${expectedUserId}", got "${meta.boundUserId}"`
      );
    }

    handshakeState.supportedActions = meta.supportedActions;
    handshakeState.supportedEvents = meta.supportedEvents;
    handshakeState.boundUserId = meta.boundUserId;
    handshakeState.meta = meta;

    stateMachine.transition({ type: 'HANDSHAKE_RECEIVED' });

    const flushed = buffer.flush('handshake');
    if (flushed.length > 0) {
      sendBuffered(flushed);
    }
  } else if (message.phase === 'ready') {
    stateMachine.transition({ type: 'READY_RECEIVED' });

    const flushed = buffer.flush('ready');
    if (flushed.length > 0) {
      sendBuffered(flushed);
    }
  }
}
