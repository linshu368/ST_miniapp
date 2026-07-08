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
  /** 握手总超时后的最大自动重连次数（默认 3；0 = 关闭重连，回到旧的一次性终止行为） */
  maxReconnectAttempts?: number;
  /** 重连退避基数（默认 2000ms）：第 n 次退避 = base * 2^n → 2s / 4s / 8s */
  reconnectBaseDelayMs?: number;
  /** 重连 attempt 的握手超时（默认 30s，短于首次 totalTimeout；reload 命中 #1 缓存后握手应很快） */
  reconnectHandshakeTimeout?: number;
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
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectHandshakeTimeout: number;

  private readonly stateMachine: BridgeStateMachine;
  private readonly buffer: RequestBuffer;
  private readonly handshakeState: HandshakeState;

  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly eventListeners = new Map<EventName, Set<EventCallback>>();

  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private started = false;

  private static readonly PING_INTERVAL_MS = 2500;

  constructor(iframeRef: () => HTMLIFrameElement | null, options?: BridgeClientOptions) {
    this.iframeRef = iframeRef;
    this.actionTimeout = options?.actionTimeout ?? HANDSHAKE_ACTION_TIMEOUT;
    this.totalTimeout = options?.totalTimeout ?? HANDSHAKE_TOTAL_TIMEOUT;
    this.expectedUserId = options?.expectedUserId ?? null;
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 3;
    this.reconnectBaseDelayMs = options?.reconnectBaseDelayMs ?? 2000;
    this.reconnectHandshakeTimeout = options?.reconnectHandshakeTimeout ?? 30_000;

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

    this.armHandshakeTimer(this.totalTimeout);
  }

  /** 武装（或重置）握手超时定时器。超时回调走 handleHandshakeTimeout（重连 or 终止）。 */
  private armHandshakeTimer(timeout: number): void {
    if (this.totalTimer) clearTimeout(this.totalTimer);
    this.totalTimer = setTimeout(() => this.handleHandshakeTimeout(), timeout);
  }

  /**
   * 握手总超时处理（安全网 #2）：ST 冷启动/资源风暴导致握手未在超时内完成时触发。
   * 只在 ready 之前可能触发（ready 时 totalTimer 已清 → 不会打断已就绪会话）。
   * 还有重连额度 → 带退避重连（重载 iframe 让 ST 重新冷启动 + 重发握手）；
   * 额度耗尽 → 终态 disconnect（停止重试，避免不可恢复场景如 cookie 失效时无限 reload）。
   */
  private handleHandshakeTimeout(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.disconnect(`Handshake timeout after ${this.reconnectAttempts} reconnect attempt(s)`);
      return;
    }
    this.scheduleReconnect();
  }

  /** 安排一次带退避的重连：进入 disconnected（reject 死请求 + 清 buffer），退避后 performReconnect。 */
  private scheduleReconnect(): void {
    this.stopPingLoop();
    this.stateMachine.transition({
      type: 'DISCONNECT',
      reason: 'Handshake timeout — scheduling reconnect',
    });
    this.rejectAllPending('Bridge reconnecting after handshake timeout');
    this.buffer.clear();

    // 第 n 次退避（0-based）= base * 2^n → 2s / 4s / 8s
    const delay = this.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts += 1;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.performReconnect();
    }, delay);
  }

  /**
   * 执行一次重连：重置握手态 → 回到 loading + 武装（更短的）重连握手超时 → 重载 iframe。
   * 重载用 src 重新赋值（origin 无关；即使 ST 内部已 302 到 /login 也会拉回 iframe 的原始
   * src=/tavern/ 重试）。父窗口的 message 监听在 reload 后仍在，ST 重启会重发握手被收到。
   */
  private performReconnect(): void {
    if (!this.started) return;

    const iframe = this.iframeRef();
    if (!iframe) {
      this.disconnect('Reconnect aborted: iframe unavailable');
      return;
    }

    // 重置握手协商结果，等待新一轮握手覆盖
    this.handshakeState.supportedActions = [];
    this.handshakeState.supportedEvents = [];
    this.handshakeState.boundUserId = null;
    this.handshakeState.meta = null;

    this.stateMachine.transition({ type: 'IFRAME_LOAD_START' });
    this.armHandshakeTimer(this.reconnectHandshakeTimeout);

    // 重载 iframe（触发 ST 冷启动 + st-extension 重新 init 并重发握手）
    const src = iframe.src;
    iframe.src = src;
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

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;

    this.stopPingLoop();
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

      if (msg.phase === 'ready') {
        if (this.totalTimer) {
          clearTimeout(this.totalTimer);
          this.totalTimer = null;
        }
        // 握手成功：清零重连计数并取消待执行的重连（安全网 #2）
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        // 连接就绪后开始周期性 ping，拉取 ST 镜像状态（currentModel/currentChatId 等），
        // 供前端 mirror store 同步（档位高亮 / 当前对话高亮）。
        this.startPingLoop();
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

  private startPingLoop(): void {
    if (this.pingTimer) return;
    this.sendPing();
    this.pingTimer = setInterval(() => this.sendPing(), BridgeClient.PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private sendPing(): void {
    const iframe = this.iframeRef();
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      {
        channel: BRIDGE_CHANNEL,
        protocolVersion: PROTOCOL_VERSION,
        type: 'ping' as const,
        timestamp: Date.now(),
      },
      '*'
    );
  }

  private disconnect(reason: string): void {
    this.stopPingLoop();
    if (this.totalTimer) {
      clearTimeout(this.totalTimer);
      this.totalTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
