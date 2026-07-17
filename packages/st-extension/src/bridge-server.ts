import {
  BRIDGE_CHANNEL,
  PROTOCOL_VERSION,
  BridgeEnvelopeSchema,
  BridgeRequestSchema,
  PingMessageSchema,
  actionRegistry,
  BridgeError,
  checkMessageSize,
  MAX_MESSAGE_SIZE,
} from '@miniapp/bridge-protocol';
import type {
  HandshakePhase,
  HandshakeMeta,
  EventName,
  EventPayloadMap,
  ActionName,
  BridgeRequestAny,
  BridgeErrorPayload,
} from '@miniapp/bridge-protocol';
import { buildMirrorState } from './mirror-state.js';

// ── Types ──

export type ActionHandler = (payload: unknown) => unknown | Promise<unknown>;

export interface BridgeServer {
  start(): void;
  stop(): void;
  sendEvent<E extends EventName>(name: E, payload: EventPayloadMap[E]): void;
  sendHandshake(phase: HandshakePhase, meta?: HandshakeMeta): void;
  getCurrentPhase(): HandshakePhase;
  setCurrentPhase(phase: HandshakePhase): void;
  registerHandler(action: ActionName, handler: ActionHandler): void;
}

// ── Implementation ──

export function createBridgeServer(parentOrigin: string): BridgeServer {
  let currentPhase: HandshakePhase = 'handshake';
  let listener: ((event: MessageEvent) => void) | null = null;
  const handlers = new Map<string, ActionHandler>();

  function postToParent(data: Record<string, unknown>): void {
    const message = {
      channel: BRIDGE_CHANNEL,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: Date.now(),
      ...data,
    };

    const serialized = JSON.stringify(message);
    try {
      checkMessageSize(serialized);
    } catch {
      console.error(
        `[bridge-server] Message exceeds size limit (${serialized.length} > ${MAX_MESSAGE_SIZE})`
      );
      return;
    }

    window.parent.postMessage(message, parentOrigin);
  }

  function handleMessage(event: MessageEvent): void {
    if (parentOrigin !== '*' && event.origin !== parentOrigin) return;

    const raw = event.data;
    if (typeof raw !== 'object' || raw === null) return;
    if (raw.channel !== BRIDGE_CHANNEL) return;

    const envelopeResult = BridgeEnvelopeSchema.safeParse(raw);
    if (!envelopeResult.success) return;

    const { type } = envelopeResult.data;

    switch (type) {
      case 'request':
        void handleRequest(raw);
        break;
      case 'ping':
        handlePing(raw);
        break;
      default:
        break;
    }
  }

  async function handleRequest(raw: unknown): Promise<void> {
    const parseResult = BridgeRequestSchema.safeParse(raw);
    if (!parseResult.success) {
      return;
    }
    const request = parseResult.data as BridgeRequestAny;

    try {
      const meta = actionRegistry[request.action as ActionName];
      if (!meta) {
        throw new BridgeError('BRIDGE_CALL_UNKNOWN_ACTION', `Unknown action: ${request.action}`, {
          requestId: request.requestId,
        });
      }

      // Phase check（序数比较）：三段握手后二元判断会把 interactive 级请求在
      // handshake 阶段误放行、或在 interactive 阶段误拦 ready 级请求。
      const phaseOrder: Record<HandshakePhase, number> = {
        handshake: 0,
        interactive: 1,
        ready: 2,
      };
      if (phaseOrder[currentPhase] < phaseOrder[meta.requiredPhase]) {
        throw new BridgeError(
          'BRIDGE_CALL_ACTION_NOT_AVAILABLE_IN_PHASE',
          `Action "${request.action}" requires phase "${meta.requiredPhase}", current is "${currentPhase}"`,
          { requestId: request.requestId }
        );
      }

      // Payload validation
      const payloadResult = meta.payloadSchema.safeParse(request.payload);
      if (!payloadResult.success) {
        throw new BridgeError(
          'BRIDGE_CALL_INVALID_PAYLOAD',
          `Invalid payload for action "${request.action}": ${payloadResult.error.message}`,
          { requestId: request.requestId }
        );
      }

      const handler = handlers.get(request.action);
      if (!handler) {
        throw new BridgeError(
          'BRIDGE_CALL_ACTION_NOT_SUPPORTED',
          `No handler registered for action: ${request.action}`,
          { requestId: request.requestId }
        );
      }

      const result = await handler(payloadResult.data);

      postToParent({
        type: 'response',
        requestId: request.requestId,
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      let errorPayload: BridgeErrorPayload;

      if (err instanceof BridgeError) {
        errorPayload = err.toPayload();
      } else {
        const message = err instanceof Error ? err.message : 'Unknown ST internal error';
        errorPayload = {
          code: 'BRIDGE_EXEC_ST_INTERNAL',
          message,
          requestId: request.requestId,
        };
      }

      postToParent({
        type: 'response',
        requestId: request.requestId,
        success: false,
        error: errorPayload,
      });
    }
  }

  function handlePing(raw: unknown): void {
    const result = PingMessageSchema.safeParse(raw);
    if (!result.success) return;

    postToParent({
      type: 'pong',
      mirrorState: buildMirrorState(),
    });
  }

  const server: BridgeServer = {
    start() {
      if (listener) return;
      listener = handleMessage;
      window.addEventListener('message', listener);
    },

    stop() {
      if (listener) {
        window.removeEventListener('message', listener);
        listener = null;
      }
    },

    sendEvent<E extends EventName>(name: E, payload: EventPayloadMap[E]) {
      postToParent({
        type: 'event',
        eventName: name,
        payload,
      });
    },

    sendHandshake(phase: HandshakePhase, meta?: HandshakeMeta) {
      postToParent({
        type: 'handshake',
        phase,
        ...(meta !== undefined && { meta }),
      });
    },

    getCurrentPhase() {
      return currentPhase;
    },

    setCurrentPhase(phase: HandshakePhase) {
      currentPhase = phase;
    },

    registerHandler(action: ActionName, handler: ActionHandler) {
      handlers.set(action, handler);
    },
  };

  return server;
}
