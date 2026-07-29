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
import { createLogger } from './logger.js';

const log = createLogger('bridge-server');

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

type ActiveAction = {
  requestId: string;
  sequence: number;
  action: ActionName;
};

// ── Implementation ──

export function createBridgeServer(parentOrigin: string): BridgeServer {
  let currentPhase: HandshakePhase = 'handshake';
  let listener: ((event: MessageEvent) => void) | null = null;
  const handlers = new Map<string, ActionHandler>();
  const activeActions = new Map<string, ActiveAction>();
  let actionSequence = 0;
  const documentId =
    new URLSearchParams(window.location.search).get('miniapp_doc') ??
    `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

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
      log.error(`Message exceeds size limit (${serialized.length} > ${MAX_MESSAGE_SIZE})`);
      return;
    }

    window.parent.postMessage(message, parentOrigin);
  }

  function getActionTarget(payload: unknown): Record<string, string | boolean> {
    if (typeof payload !== 'object' || payload === null) return {};
    const value = payload as Record<string, unknown>;
    const target: Record<string, string | boolean> = {};
    for (const key of ['avatar', 'fileName', 'chatName']) {
      if (typeof value[key] === 'string') target[key] = value[key];
    }
    for (const key of ['forceNewChat', 'skipChatLoad']) {
      if (typeof value[key] === 'boolean') target[key] = value[key];
    }
    return target;
  }

  function getChatState(): Record<string, unknown> {
    try {
      const state = buildMirrorState();
      return {
        userId: state.userId,
        characterId: state.currentCharacterId,
        chatId: state.currentChatId,
        messageCount: state.messageCount,
      };
    } catch (error) {
      return { unavailable: error instanceof Error ? error.message : String(error) };
    }
  }

  function sendActionTrace(
    action: ActiveAction,
    stage: 'handler_start' | 'handler_end',
    payload: unknown,
    extra: Record<string, unknown> = {}
  ): void {
    postToParent({
      type: 'debug-chat-action',
      event: {
        source: 'st-handler',
        stage,
        documentId,
        requestId: action.requestId,
        sequence: action.sequence,
        action: action.action,
        phase: currentPhase,
        active: [...activeActions.values()],
        target: getActionTarget(payload),
        state: getChatState(),
        ...extra,
      },
    });
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
    const actionTrace: ActiveAction = {
      requestId: request.requestId,
      sequence: ++actionSequence,
      action: request.action as ActionName,
    };
    const startedAt = Date.now();
    let outcome = 'success';
    activeActions.set(request.requestId, actionTrace);
    sendActionTrace(actionTrace, 'handler_start', request.payload);

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
      outcome = errorPayload.code;

      postToParent({
        type: 'response',
        requestId: request.requestId,
        success: false,
        error: errorPayload,
      });
    } finally {
      activeActions.delete(request.requestId);
      sendActionTrace(actionTrace, 'handler_end', request.payload, {
        outcome,
        durationMs: Date.now() - startedAt,
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
