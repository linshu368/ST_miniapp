import type {
  ActionName,
  ActionPayloadMap,
  ActionResultMap,
  EventName,
  EventPayloadMap,
  BridgeResponseAny,
  HandshakeMessage,
  BridgeEventAny,
  PongMessage,
} from '@miniapp/bridge-protocol';
import {
  BRIDGE_CHANNEL,
  PROTOCOL_VERSION,
  HANDSHAKE_ACTION_TIMEOUT,
  HANDSHAKE_TOTAL_TIMEOUT,
  BridgeError,
  actionRegistry,
} from '@miniapp/bridge-protocol';
import { createStateMachine } from './state-machine';
import type { BridgeStateMachine, BridgeStatus } from './state-machine';
import { RequestBuffer } from './buffer';
import type { BufferedRequest } from './buffer';
import { createHandshakeState, handleHandshakeMessage } from './handshake';
import type { HandshakeState } from './handshake';

export type BridgeClientOptions = {
  actionTimeout?: number;
  totalTimeout?: number;
  expectedUserId?: string | null;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventCallback<E extends EventName = EventName> = (payload: EventPayloadMap[E]) => void;

export class BridgeClient {
  private readonly iframeRef: () => HTMLIFrameElement | null;
  private readonly actionTimeout: number;
  private readonly totalTimeout: number;
  private readonly expectedUserId: string | null;

  private readonly stateMachine: BridgeStateMachine;
  private readonly buffer: RequestBuffer;
  private readonly handshakeState: HandshakeState;

  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly eventListeners = new Map<EventName, Set<EventCallback>>();

  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private started = false;

  constructor(iframeRef: () => HTMLIFrameElement | null, options?: BridgeClientOptions) {
    this.iframeRef = iframeRef;
    this.actionTimeout = options?.actionTimeout ?? HANDSHAKE_ACTION_TIMEOUT;
    this.totalTimeout = options?.totalTimeout ?? HANDSHAKE_TOTAL_TIMEOUT;
    this.expectedUserId = options?.expectedUserId ?? null;

    this.stateMachine = createStateMachine();
    this.buffer = new RequestBuffer();
    this.handshakeState = createHandshakeState();
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.stateMachine.transition({ type: 'IFRAME_LOAD_START' });

    this.messageHandler = (event: MessageEvent) => {
      this.handleMessage(event);
    };
    window.addEventListener('message', this.messageHandler);

    this.totalTimer = setTimeout(() => {
      this.disconnect('Total handshake timeout');
    }, this.totalTimeout);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }

    if (this.totalTimer) {
      clearTimeout(this.totalTimer);
      this.totalTimer = null;
    }

    this.rejectAllPending('Bridge client stopped');
    this.buffer.clear();
    this.stateMachine.reset();
  }

  getStatus(): BridgeStatus {
    return this.stateMachine.getStatus();
  }

  onStatusChange(cb: (status: BridgeStatus) => void): () => void {
    return this.stateMachine.onStatusChange(cb);
  }

  isActionSupported(action: ActionName): boolean {
    return this.handshakeState.supportedActions.includes(action);
  }

  sendAction<A extends ActionName>(
    action: A,
    payload: ActionPayloadMap[A]
  ): Promise<ActionResultMap[A]> {
    const status = this.stateMachine.getStatus();

    if (status === 'disconnected' || status === 'idle') {
      return Promise.reject(
        new BridgeError('BRIDGE_CONN_DISCONNECTED', `Cannot send action in status: ${status}`)
      );
    }

    const meta = actionRegistry[action];
    const requestId = generateRequestId();

    if (status === 'loading' || (status === 'handshaked' && meta.requiredPhase === 'ready')) {
      if (!meta.waitable) {
        return Promise.reject(
          new BridgeError(
            'BRIDGE_CALL_ACTION_NOT_AVAILABLE_IN_PHASE',
            `Action "${action}" not waitable and current phase insufficient`
          )
        );
      }

      return new Promise<ActionResultMap[A]>((resolve, reject) => {
        this.buffer.enqueue({
          requestId,
          action,
          payload,
          resolve: resolve as (v: unknown) => void,
          reject,
          requiredPhase: meta.requiredPhase,
        });
      });
    }

    return this.doSend(requestId, action, payload);
  }

  onEvent<E extends EventName>(name: E, cb: (payload: EventPayloadMap[E]) => void): () => void {
    let listeners = this.eventListeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(name, listeners);
    }
    listeners.add(cb as EventCallback);
    return () => {
      listeners!.delete(cb as EventCallback);
    };
  }

  private doSend<A extends ActionName>(
    requestId: string,
    action: A,
    payload: ActionPayloadMap[A]
  ): Promise<ActionResultMap[A]> {
    const iframe = this.iframeRef();
    if (!iframe?.contentWindow) {
      return Promise.reject(
        new BridgeError('BRIDGE_CONN_IFRAME_UNAVAILABLE', 'iframe contentWindow not available')
      );
    }

    return new Promise<ActionResultMap[A]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new BridgeError(
            'BRIDGE_CALL_TIMEOUT',
            `Action "${action}" timed out after ${this.actionTimeout}ms`
          )
        );
      }, this.actionTimeout);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      const message = {
        channel: BRIDGE_CHANNEL,
        protocolVersion: PROTOCOL_VERSION,
        type: 'request' as const,
        timestamp: Date.now(),
        requestId,
        action,
        payload,
      };

      iframe.contentWindow!.postMessage(message, '*');
    });
  }

  private handleMessage(event: MessageEvent): void {
    const data = event.data;
    if (typeof data !== 'object' || data == null) return;
    if (data.channel !== BRIDGE_CHANNEL) return;

    const { type } = data;

    switch (type) {
      case 'response':
        this.handleResponse(data as BridgeResponseAny);
        break;
      case 'event':
        this.handleEvent(data as BridgeEventAny);
        break;
      case 'handshake':
        this.handleHandshake(data as HandshakeMessage);
        break;
      case 'pong':
        this.handlePong(data as PongMessage);
        break;
    }
  }

  private handleResponse(msg: BridgeResponseAny): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.requestId);

    if (msg.success) {
      pending.resolve(msg.data);
    } else {
      const err = msg.error;
      pending.reject(
        new BridgeError(
          err?.code ?? 'BRIDGE_EXEC_ST_INTERNAL',
          err?.message ?? 'Unknown bridge error',
          { requestId: msg.requestId, context: err?.context }
        )
      );
    }
  }

  private handleEvent(msg: BridgeEventAny): void {
    const listeners = this.eventListeners.get(msg.eventName as EventName);
    if (!listeners || listeners.size === 0) return;
    listeners.forEach((cb) => {
      try {
        cb(msg.payload as EventPayloadMap[EventName]);
      } catch {
        /* subscriber error */
      }
    });
  }

  private handleHandshake(msg: HandshakeMessage): void {
    try {
      handleHandshakeMessage({
        message: msg,
        stateMachine: this.stateMachine,
        handshakeState: this.handshakeState,
        buffer: this.buffer,
        expectedUserId: this.expectedUserId,
        sendBuffered: (requests) => this.flushBufferedRequests(requests),
      });

      if (msg.phase === 'ready' && this.totalTimer) {
        clearTimeout(this.totalTimer);
        this.totalTimer = null;
      }
    } catch (e) {
      this.disconnect(e instanceof Error ? e.message : 'Handshake failed');
    }
  }

  private handlePong(msg: PongMessage): void {
    // Mirror state update is handled by the store subscriber externally
    const listeners = this.eventListeners.get('settings:updated' as EventName);
    if (listeners) {
      // Pong carries full mirror state - we emit it as a synthetic event
      // so external consumers can react. Actual store update is done in bridge-client setup.
    }
    // Emit pong data for external mirror state consumers
    this.pongListeners.forEach((cb) => cb(msg.mirrorState));
  }

  private pongListeners = new Set<
    (state: import('@miniapp/bridge-protocol').STMirrorState) => void
  >();

  onPong(cb: (state: import('@miniapp/bridge-protocol').STMirrorState) => void): () => void {
    this.pongListeners.add(cb);
    return () => {
      this.pongListeners.delete(cb);
    };
  }

  private flushBufferedRequests(requests: BufferedRequest[]): void {
    for (const req of requests) {
      this.doSend(req.requestId, req.action, req.payload as ActionPayloadMap[typeof req.action])
        .then(req.resolve)
        .catch(req.reject);
    }
  }

  private disconnect(reason: string): void {
    this.stateMachine.transition({ type: 'DISCONNECT', reason });
    this.rejectAllPending(reason);
    this.buffer.clear();
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError('BRIDGE_CONN_DISCONNECTED', reason, { requestId: id }));
    }
    this.pendingRequests.clear();
  }
}

let counter = 0;
function generateRequestId(): string {
  return `req_${Date.now()}_${++counter}`;
}
