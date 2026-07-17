import type {
  ActionName,
  ActionPayloadMap,
  ActionResultMap,
  EventName,
  EventPayloadMap,
  BridgeResponseAny,
  HandshakeMessage,
  HandshakePhase,
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
import { markTiming, markTimingAt } from './iframe-timing'; // [iframe-timing] TEMP DEBUG

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
  /**
   * iframe 加载看门狗（安全网 #3）：start/重连后超过该时长仍未收到 iframe load 事件，
   * 视为首次加载停摆（实测部署窗口下连接挂死：文档已回来但后续请求全无、load 永不触发），
   * 不等 60s 握手总超时、立即走重连。默认 15s；0 = 关闭。
   */
  iframeLoadTimeout?: number;
  /**
   * 握手到达看门狗（安全网 #4）：start/重连后超过该时长仍未收到首段握手消息即走重连。
   * 覆盖 load 看门狗防不住的停摆变体（pro 实测：静态资源 1s 内全到、load 已触发，
   * 但 boot JS 在 /csrf-token 往返后连接挂死、后续 fetch 永久 pending → 握手永不到达）。
   * 正常首段握手最迟 ~17s 到达（10 样本最差值），默认 30s；0 = 关闭。
   */
  handshakeArrivalTimeout?: number;
  /**
   * 点卡即检重载阈值（安全网 #5）：用户点卡进入 /tavern/ 时 iframe 由隐藏转可见
   * （重载只在可见态 100% 恢复）。若此刻仍未握手，则按「距本次 boot 起点的该时长」武装一枚更
   * 激进的停摆重载——到点仍无握手即重载，不必干等 30s 握手到达看门狗；点卡时若已超阈值则立即重载。
   * 默认 18s（> 正常最迟握手 ~17.5s，不误伤健康慢 boot）；0 = 关闭。
   */
  visibleStallReloadMs?: number;
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
  private readonly iframeLoadTimeout: number;
  private readonly handshakeArrivalTimeout: number;
  private readonly visibleStallReloadMs: number;

  private readonly stateMachine: BridgeStateMachine;
  private readonly buffer: RequestBuffer;
  private readonly handshakeState: HandshakeState;

  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly eventListeners = new Map<EventName, Set<EventCallback>>();

  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private iframeLoadTimer: ReturnType<typeof setTimeout> | null = null;
  private iframeLoadHandler: (() => void) | null = null;
  private handshakeArrivalTimer: ReturnType<typeof setTimeout> | null = null;
  private clickStallTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private started = false;
  /** 本次 boot 尝试（start 或 reconnect reload）起点，用于点卡即检的相对阈值计算 */
  private bootAttemptStartedAt = 0;
  /** 用户是否已点卡进入 /tavern/（iframe 转可见）；决定重连后是否也走激进的点卡即检阈值 */
  private userWaiting = false;

  private static readonly PING_INTERVAL_MS = 2500;

  constructor(iframeRef: () => HTMLIFrameElement | null, options?: BridgeClientOptions) {
    this.iframeRef = iframeRef;
    this.actionTimeout = options?.actionTimeout ?? HANDSHAKE_ACTION_TIMEOUT;
    this.totalTimeout = options?.totalTimeout ?? HANDSHAKE_TOTAL_TIMEOUT;
    this.expectedUserId = options?.expectedUserId ?? null;
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 3;
    this.reconnectBaseDelayMs = options?.reconnectBaseDelayMs ?? 2000;
    this.reconnectHandshakeTimeout = options?.reconnectHandshakeTimeout ?? 30_000;
    this.iframeLoadTimeout = options?.iframeLoadTimeout ?? 15_000;
    this.handshakeArrivalTimeout = options?.handshakeArrivalTimeout ?? 30_000;
    this.visibleStallReloadMs = options?.visibleStallReloadMs ?? 10_000;

    this.stateMachine = createStateMachine();
    this.buffer = new RequestBuffer();
    this.handshakeState = createHandshakeState();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.bootAttemptStartedAt = Date.now();

    markTiming('bridge_start'); // [iframe-timing] TEMP DEBUG
    this.stateMachine.transition({ type: 'IFRAME_LOAD_START' });

    this.messageHandler = (event: MessageEvent) => {
      this.handleMessage(event);
    };
    window.addEventListener('message', this.messageHandler);

    this.armHandshakeTimer(this.totalTimeout);
    this.attachIframeLoadListener();
    this.armIframeLoadWatchdog();
    this.armHandshakeArrivalWatchdog();
  }

  /**
   * 握手到达看门狗（安全网 #4）：start/重连后 handshakeArrivalTimeout 内首段握手未到即重连。
   * 与 load 看门狗互补：load 已触发但 boot JS 半途连接挂死（fetch 永久 pending）时，
   * load 看门狗已解除、握手总超时要等满 60s，本看门狗把该变体压到 ~30s。
   * 收到任意握手消息即解除（ready 阶段的慢由握手总超时兜底，不误伤正常慢 boot）。
   */
  private armHandshakeArrivalWatchdog(): void {
    this.clearHandshakeArrivalWatchdog();
    if (this.handshakeArrivalTimeout <= 0) return;
    this.handshakeArrivalTimer = setTimeout(() => {
      this.handshakeArrivalTimer = null;
      markTiming('handshake_arrival_watchdog'); // [iframe-timing] TEMP DEBUG
      this.handleHandshakeTimeout();
    }, this.handshakeArrivalTimeout);
  }

  private clearHandshakeArrivalWatchdog(): void {
    if (this.handshakeArrivalTimer) {
      clearTimeout(this.handshakeArrivalTimer);
      this.handshakeArrivalTimer = null;
    }
  }

  /**
   * 点卡即检（安全网 #5）：由壳端在用户进入 /tavern/（iframe 转可见）时调用。
   * iframe 可见后重载才 100% 恢复（pro 实测：停摆发生在隐藏预热期，转可见并不能就地解楔，
   * 只有重载才行）。因此这里在「仍未握手」时武装一枚比 30s 握手到达看门狗更早的停摆重载。
   * 与握手到达看门狗并存、取更早者（handleHandshakeTimeout 用 reconnectTimer 去重，绝不更慢）；
   * 阈值相对本次 boot 起点计（点卡时若已超阈值 → 立即重载）。收到任意握手即解除。
   */
  onActivated(): void {
    if (!this.started) return;
    this.userWaiting = true;
    // 仅在「尚未收到首段握手」（loading）时介入；handshaked/ready/disconnected 皆无需
    if (this.stateMachine.getStatus() !== 'loading') return;
    this.armClickStallWatchdog();
  }

  private armClickStallWatchdog(): void {
    this.clearClickStallWatchdog();
    if (this.visibleStallReloadMs <= 0) return;
    const elapsed = Date.now() - this.bootAttemptStartedAt;
    const remaining = Math.max(0, this.visibleStallReloadMs - elapsed);
    this.clickStallTimer = setTimeout(() => {
      this.clickStallTimer = null;
      markTiming('click_stall_reload'); // [iframe-timing] TEMP DEBUG
      this.handleHandshakeTimeout();
    }, remaining);
  }

  private clearClickStallWatchdog(): void {
    if (this.clickStallTimer) {
      clearTimeout(this.clickStallTimer);
      this.clickStallTimer = null;
    }
  }

  /**
   * iframe 加载看门狗（安全网 #3）：监听 iframe 的 load 事件，start/重连后 iframeLoadTimeout
   * 内未触发即视为首次加载停摆，立即走重连（共享握手超时的重连额度与退避），把实测部署窗口下
   * 「文档已回来但后续请求全无、load 永不触发 → 白等 60s 握手总超时」的极端等待压到 ~15s。
   */
  private attachIframeLoadListener(): void {
    const iframe = this.iframeRef();
    if (!iframe || this.iframeLoadHandler) return;
    this.iframeLoadHandler = () => this.clearIframeLoadWatchdog();
    iframe.addEventListener('load', this.iframeLoadHandler);
  }

  private detachIframeLoadListener(): void {
    if (!this.iframeLoadHandler) return;
    this.iframeRef()?.removeEventListener('load', this.iframeLoadHandler);
    this.iframeLoadHandler = null;
  }

  private armIframeLoadWatchdog(): void {
    this.clearIframeLoadWatchdog();
    if (this.iframeLoadTimeout <= 0) return;
    this.iframeLoadTimer = setTimeout(() => {
      this.iframeLoadTimer = null;
      markTiming('iframe_load_watchdog'); // [iframe-timing] TEMP DEBUG
      this.handleHandshakeTimeout();
    }, this.iframeLoadTimeout);
  }

  private clearIframeLoadWatchdog(): void {
    if (this.iframeLoadTimer) {
      clearTimeout(this.iframeLoadTimer);
      this.iframeLoadTimer = null;
    }
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
    // 多个看门狗（load/握手到达/总超时）可能相继超时；已有重连排队时不重复调度
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.disconnect(`Handshake timeout after ${this.reconnectAttempts} reconnect attempt(s)`);
      return;
    }
    this.scheduleReconnect();
  }

  /** 安排一次带退避的重连：进入 disconnected（reject 死请求 + 清 buffer），退避后 performReconnect。 */
  private scheduleReconnect(): void {
    this.stopPingLoop();
    this.clearIframeLoadWatchdog();
    this.clearHandshakeArrivalWatchdog();
    this.clearClickStallWatchdog();
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
    this.bootAttemptStartedAt = Date.now();
    this.armHandshakeTimer(this.reconnectHandshakeTimeout);

    // 重载 iframe（触发 ST 冷启动 + st-extension 重新 init 并重发握手）。
    // 每次重载重新生成 miniapp_doc 查询参数：URL 从未出现过 → WKWebView 不可能复活
    // 旧缓存文档（旧模块图与新模块图并行执行会导致 boot 停摆，见 st-iframe.tsx）。
    const url = new URL(iframe.src, window.location.origin);
    url.searchParams.set('miniapp_doc', Date.now().toString(36));
    iframe.src = url.toString();

    // 重载后重新武装加载/握手到达看门狗（load 监听器挂在同一 iframe 元素上，reload 后仍有效）
    this.attachIframeLoadListener();
    this.armIframeLoadWatchdog();
    this.armHandshakeArrivalWatchdog();
    // 若用户已在等待（点卡进过 /tavern/），本次重连也是可见态 → 同样走激进的点卡即检阈值
    if (this.userWaiting) this.armClickStallWatchdog();
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
    this.userWaiting = false;

    this.clearIframeLoadWatchdog();
    this.clearHandshakeArrivalWatchdog();
    this.clearClickStallWatchdog();
    this.detachIframeLoadListener();
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

    // 序数比较：当前连接状态尚未达到 action 的 requiredPhase 时入 buffer 等 flush。
    // loading（首段握手未到）缓冲一切；handshaked=0 / interactive=1 / ready=2。
    const statusLevel: Partial<Record<BridgeStatus, number>> = {
      handshaked: 0,
      interactive: 1,
      ready: 2,
    };
    const requiredLevel: Record<HandshakePhase, number> = {
      handshake: 0,
      interactive: 1,
      ready: 2,
    };
    const currentLevel = statusLevel[status] ?? -1;

    if (currentLevel < requiredLevel[meta.requiredPhase]) {
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
      // [iframe-timing] TEMP DEBUG: ST iframe 端相位打点
      case 'debug-timing':
        markTimingAt(
          data.name as string,
          typeof data.t === 'number' ? data.t : Date.now(),
          typeof data.info === 'string' ? data.info : undefined
        );
        break;
      // boot 致命异常（vendor 探针上报，如坏模块图 TDZ）：boot 已确定死亡，
      // 不必干等 10~45s 看门狗，立即走既有重连预算重载。
      case 'boot-fatal':
        this.handleBootFatal(typeof data.detail === 'string' ? data.detail : '');
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

  /**
   * boot 致命异常处理：vendor 探针在握手前捕获到坏模块图签名（TDZ ReferenceError、
   * 模块加载失败等）即上报。此时 boot 已确定死亡（firstLoadInit 中断、握手永不到达），
   * 立即触发重连重载，复用既有的退避与额度（额度耗尽仍走 disconnect 终态）。
   * 仅在 interactive 之前介入——interactive 后 ST 已可服务，偶发错误不值得重载。
   */
  private handleBootFatal(detail: string): void {
    markTimingAt('boot_fatal', Date.now(), detail.slice(0, 160)); // [iframe-timing] TEMP DEBUG
    const status = this.stateMachine.getStatus();
    if (status !== 'loading' && status !== 'handshaked') return;
    this.handleHandshakeTimeout();
  }

  private handleHandshake(msg: HandshakeMessage): void {
    // 握手已到 = ST 脚本在跑，加载必然未停摆；解除 load/握手到达/点卡即检三道看门狗
    this.clearIframeLoadWatchdog();
    this.clearHandshakeArrivalWatchdog();
    this.clearClickStallWatchdog();
    // [iframe-timing] TEMP DEBUG: 记录三段握手到达时刻
    markTiming(
      msg.phase === 'ready'
        ? 'st_ready'
        : msg.phase === 'interactive'
          ? 'st_interactive'
          : 'st_handshake'
    );
    try {
      handleHandshakeMessage({
        message: msg,
        stateMachine: this.stateMachine,
        handshakeState: this.handshakeState,
        buffer: this.buffer,
        expectedUserId: this.expectedUserId,
        sendBuffered: (requests) => this.flushBufferedRequests(requests),
      });

      if (msg.phase === 'interactive') {
        // interactive 即视为连接建立：必须解除 60s 握手总超时。T2 的目标人群恰是慢 boot
        // 长尾（APP_READY 可能 >60s），若不解除，闸门在 interactive 放行后发起的 select
        // 会被总超时触发的 iframe 重载腰斩。残余风险（interactive 后卡死到不了 ready 时
        // 无看门狗兜底）可接受：interactive 已证明 ST boot JS 存活且在推进。
        if (this.totalTimer) {
          clearTimeout(this.totalTimer);
          this.totalTimer = null;
        }
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        // ping loop 仍等 ready 才启动：mirror 状态在 ready 前无消费者，且避免与
        // interactive 窗口内的 select 请求竞争。
      }

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
    this.clearIframeLoadWatchdog();
    this.clearHandshakeArrivalWatchdog();
    this.clearClickStallWatchdog();
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
