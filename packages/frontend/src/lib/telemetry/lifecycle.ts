'use client';

import {
  REPLAY_IDLE_TIMEOUT_MS,
  type GetReplayContextData,
  type ReplayChatEndReason,
  type ReplayTelemetryEvent,
} from '@miniapp/shared';

import { getPostHogAdapter, type PostHogAdapter } from './adapter';

export type ReplayLifecycleState =
  | 'idle'
  | 'chat'
  | 'recharge'
  | 'paywall_followup'
  | 'external_payment_pending'
  | 'ended';

export type StartChatReplayInput = {
  characterId: string;
  conversationSessionId: string;
  selectedModelId: string | null;
};

export type ReplayLifecycleSnapshot = {
  state: ReplayLifecycleState;
  replayContextId: string | null;
  telemetryReady: boolean;
  streaming: boolean;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Omit 对 discriminated union 必须可分发，否则 capture 草稿会丢掉事件专有字段。 */

export type ReplayEventDraft = DistributiveOmit<
  ReplayTelemetryEvent,
  'telegram_user_id' | 'replay_context_id' | 'occurred_at' | 'is_paid_user' | 'total_chat_rounds'
> & {
  is_paid_user?: boolean;
  total_chat_rounds?: number;
  replay_context_id?: string;
  telegram_user_id?: string;
  occurred_at?: string;
};

type ChatIdentity = {
  telegramUserId: string;
  characterId: string;
  conversationSessionId: string;
  selectedModelId: string | null;
};

type UserTags = {
  is_paid_user?: boolean;
  total_chat_rounds?: number;
};

export type ReplayLifecycleDeps = {
  adapter?: PostHogAdapter;
  now?: () => Date;
  createContextId?: () => string;
  addWindowListener?: (type: string, listener: EventListener) => void;
  removeWindowListener?: (type: string, listener: EventListener) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
};

const INITIAL_SNAPSHOT: ReplayLifecycleSnapshot = {
  state: 'idle',
  replayContextId: null,
  telemetryReady: false,
  streaming: false,
};

function createContextId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries) as T;
}

export function createReplayLifecycle(deps: ReplayLifecycleDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const makeId = deps.createContextId ?? createContextId;
  const addWindowListener =
    deps.addWindowListener ??
    ((type, listener) => {
      if (typeof window === 'undefined') return;
      window.addEventListener(type, listener);
    });
  const removeWindowListener =
    deps.removeWindowListener ??
    ((type, listener) => {
      if (typeof window === 'undefined') return;
      window.removeEventListener(type, listener);
    });
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  const listeners = new Set<() => void>();
  let snapshot: ReplayLifecycleSnapshot = INITIAL_SNAPSHOT;
  let identity: ChatIdentity | null = null;
  let rechargeUserId: string | null = null;
  let rechargeStarting = false;
  let rechargeStartGeneration = 0;
  let rechargeResumeMode = false;
  let rechargeExitRequested = false;
  const pendingRechargeEvents: ReplayEventDraft[] = [];
  let userTags: UserTags = {};
  let queue: Promise<void> = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let attached = false;
  let contextFetchFailedFor: string | null = null;
  // 必须在 router.push / unmount 之前同步置位，否则 occupancy 的 route_change
  // 会抢在 queued enterPaywallFollowup 前结束 context。
  let paywallHold = false;

  const activityListener: EventListener = () => {
    notifyUserActivity();
  };

  function isPaywallContinuationActive(): boolean {
    if (paywallHold) return true;
    return snapshot.state === 'paywall_followup' || snapshot.state === 'external_payment_pending';
  }

  function sameChatIdentity(input: StartChatReplayInput): boolean {
    return Boolean(
      identity &&
      identity.characterId === input.characterId &&
      identity.conversationSessionId === input.conversationSessionId
    );
  }

  const pageHideListener: EventListener = () => {
    if (isPaywallContinuationActive()) return;
    if (snapshot.state !== 'chat' && snapshot.state !== 'recharge') return;
    void endReplay('pagehide');
  };

  function adapter(): PostHogAdapter {
    return deps.adapter ?? getPostHogAdapter();
  }

  function emit(): void {
    snapshot = {
      state: snapshot.state,
      replayContextId: snapshot.replayContextId,
      telemetryReady: adapter().isReady(),
      streaming: snapshot.streaming,
    };
    for (const listener of listeners) listener();
  }

  function setState(
    state: ReplayLifecycleState,
    replayContextId: string | null = snapshot.replayContextId
  ): void {
    snapshot = {
      ...snapshot,
      state,
      replayContextId,
      telemetryReady: adapter().isReady(),
    };
    emit();
  }

  function clearIdleTimer(): void {
    if (idleTimer === undefined) return;
    clearTimeoutFn(idleTimer);
    idleTimer = undefined;
  }

  function idleTimerAllowed(): boolean {
    if (snapshot.streaming) return false;
    return (
      snapshot.state === 'chat' ||
      snapshot.state === 'recharge' ||
      snapshot.state === 'paywall_followup'
    );
  }

  function armIdleTimer(): void {
    clearIdleTimer();
    if (!idleTimerAllowed()) return;
    idleTimer = setTimeoutFn(() => {
      idleTimer = undefined;
      if (!idleTimerAllowed()) return;
      void endReplay('idle_timeout');
    }, REPLAY_IDLE_TIMEOUT_MS);
  }

  function notifyUserActivity(): void {
    if (!idleTimerAllowed()) return;
    armIdleTimer();
  }

  function enqueue(work: () => void | Promise<void>): Promise<void> {
    queue = queue.then(work, work);
    return queue;
  }

  function sessionProperties(): Record<string, string | number | boolean | null> {
    if (!snapshot.replayContextId) return {};
    if (!identity) return { replay_context_id: snapshot.replayContextId };
    return omitUndefined({
      replay_context_id: snapshot.replayContextId,
      character_id: identity.characterId,
      conversation_session_id: identity.conversationSessionId,
      selected_model_id: identity.selectedModelId,
    });
  }

  function captureStarted(): void {
    if (!identity || !identity.telegramUserId || !snapshot.replayContextId) return;
    adapter().capture(
      omitUndefined({
        event: 'replay_chat_started' as const,
        telegram_user_id: identity.telegramUserId,
        replay_context_id: snapshot.replayContextId,
        occurred_at: now().toISOString(),
        character_id: identity.characterId,
        conversation_session_id: identity.conversationSessionId,
        selected_model_id: identity.selectedModelId,
        ...userTags,
      })
    );
  }

  function captureEnded(reason: ReplayChatEndReason): void {
    if (!identity || !identity.telegramUserId || !snapshot.replayContextId) return;
    adapter().capture(
      omitUndefined({
        event: 'replay_chat_ended' as const,
        telegram_user_id: identity.telegramUserId,
        replay_context_id: snapshot.replayContextId,
        occurred_at: now().toISOString(),
        character_id: identity.characterId,
        conversation_session_id: identity.conversationSessionId,
        selected_model_id: identity.selectedModelId,
        end_reason: reason,
        ...userTags,
      })
    );
  }

  function armRecordingIfNeeded(): void {
    const contextId = snapshot.replayContextId;
    if (!contextId) return;
    if (
      snapshot.state !== 'chat' &&
      snapshot.state !== 'recharge' &&
      snapshot.state !== 'paywall_followup' &&
      snapshot.state !== 'external_payment_pending'
    ) {
      return;
    }
    if (snapshot.state === 'external_payment_pending' || rechargeStarting) return;
    if (!adapter().isReady() || adapter().isRecording()) return;
    if (snapshot.state === 'recharge' && rechargeResumeMode) {
      adapter().resumeRecording(contextId);
    } else {
      adapter().startNewRecording(contextId);
    }
    adapter().registerSessionProperties(sessionProperties());
    if (snapshot.state === 'chat') captureStarted();
  }

  function keepCurrentChatReplay(input: StartChatReplayInput): void {
    if (!identity) return;
    identity = {
      ...identity,
      telegramUserId: identity.telegramUserId || adapter().getDistinctId() || '',
      selectedModelId: input.selectedModelId,
    };
    adapter().registerSessionProperties(sessionProperties());
    armRecordingIfNeeded();
  }

  async function startChatReplay(input: StartChatReplayInput): Promise<string | null> {
    await enqueue(async () => {
      // adapter.loadSdk 有超时；这里若永不 settle，followup/endReplay 会一起挂死。
      await adapter().whenReady();
      const telegramUserId = adapter().getDistinctId();
      const activeFollowup =
        paywallHold ||
        snapshot.state === 'paywall_followup' ||
        snapshot.state === 'external_payment_pending';

      // 付费墙跳转时聊天页仍可能重绑（selectedModelId / Strict Mode）。
      // 若把 paywall_followup 当成新聊天，会立刻 route_change 掉原 context。
      if (sameChatIdentity(input) && (snapshot.state === 'chat' || activeFollowup)) {
        keepCurrentChatReplay(input);
        return;
      }

      const switchingAway = Boolean(identity) && !sameChatIdentity(input);
      if (snapshot.state === 'chat' || snapshot.state === 'paywall_followup') {
        captureEnded('route_change');
        adapter().stopRecording(snapshot.replayContextId ?? undefined);
      } else if (snapshot.state === 'recharge') {
        adapter().stopRecording(snapshot.replayContextId ?? undefined);
      } else if (snapshot.state === 'external_payment_pending') {
        adapter().stopRecording(snapshot.replayContextId ?? undefined);
      }

      if (
        switchingAway ||
        (!identity && snapshot.state === 'external_payment_pending') ||
        snapshot.state === 'recharge'
      ) {
        paywallHold = false;
      }
      const replayContextId = makeId();
      rechargeUserId = null;
      pendingRechargeEvents.length = 0;
      rechargeStarting = false;
      rechargeStartGeneration += 1;
      rechargeResumeMode = false;
      rechargeExitRequested = false;
      identity = {
        telegramUserId: telegramUserId ?? '',
        characterId: input.characterId,
        conversationSessionId: input.conversationSessionId,
        selectedModelId: input.selectedModelId,
      };
      userTags = {};
      contextFetchFailedFor = null;
      snapshot = {
        state: paywallHold ? 'paywall_followup' : 'chat',
        replayContextId,
        telemetryReady: adapter().isReady(),
        streaming: false,
      };
      emit();
      adapter().startNewRecording(replayContextId);
      adapter().registerSessionProperties(sessionProperties());
      captureStarted();
      armIdleTimer();
    });
    return snapshot.replayContextId;
  }

  /** 点击处理器不能等待 SDK：先同步保留 context，再异步启动并发送排队的入口事件。 */
  function startRechargeReplay(telegramUserId?: string | null): string {
    if (snapshot.replayContextId && (identity || snapshot.state === 'recharge')) {
      return snapshot.replayContextId;
    }
    if (snapshot.replayContextId) adapter().stopRecording(snapshot.replayContextId);
    const contextId = makeId();
    identity = null;
    rechargeUserId = telegramUserId?.trim() || null;
    userTags = {};
    paywallHold = false;
    rechargeStarting = true;
    const generation = ++rechargeStartGeneration;
    rechargeResumeMode = false;
    rechargeExitRequested = false;
    adapter().clearReplaySessionProperties();
    setState('recharge', contextId);
    armIdleTimer();
    void enqueue(async () => {
      const ready = await adapter().whenReady();
      if (generation !== rechargeStartGeneration) {
        if (
          ready &&
          snapshot.replayContextId === contextId &&
          snapshot.state === 'external_payment_pending'
        ) {
          rechargeUserId = rechargeUserId || adapter().getDistinctId() || null;
          adapter().clearReplaySessionProperties();
          adapter().registerSessionProperties(sessionProperties());
          rechargeStarting = false;
          pendingRechargeEvents.splice(0).forEach((draft) => capture(draft));
        }
        return;
      }
      if (
        snapshot.replayContextId !== contextId ||
        snapshot.state !== 'recharge' ||
        rechargeExitRequested
      )
        return;
      rechargeUserId = rechargeUserId || adapter().getDistinctId() || null;
      if (ready) {
        adapter().clearReplaySessionProperties();
        adapter().startNewRecording(contextId);
        adapter().registerSessionProperties(sessionProperties());
      }
      rechargeStarting = false;
      const drafts = pendingRechargeEvents.splice(0);
      if (ready) drafts.forEach((draft) => capture(draft));
    });
    return contextId;
  }

  function restorePaymentReplay(contextId: string, telegramUserId?: string | null): void {
    if (
      snapshot.replayContextId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(contextId)
    )
      return;
    identity = null;
    rechargeUserId = telegramUserId?.trim() || adapter().getDistinctId() || null;
    rechargeResumeMode = true;
    adapter().clearReplaySessionProperties();
    setState('external_payment_pending', contextId);
    // 新文档只恢复关联上下文；直到确认回到 MiniApp 才重新录制。
  }

  function resumePaymentReplay(): void {
    if (snapshot.state !== 'external_payment_pending' || !snapshot.replayContextId) return;
    const contextId = snapshot.replayContextId;
    if (!identity) rechargeResumeMode = true;
    paywallHold = Boolean(identity);
    setState(identity ? 'paywall_followup' : 'recharge');
    if (adapter().isReady()) {
      if (!identity) adapter().clearReplaySessionProperties();
      adapter().resumeRecording(contextId);
      adapter().registerSessionProperties(sessionProperties());
      rechargeStarting = false;
      pendingRechargeEvents.splice(0).forEach((draft) => capture(draft));
    } else {
      rechargeStarting = true;
      void enqueue(async () => {
        const ready = await adapter().whenReady();
        if (snapshot.replayContextId !== contextId || rechargeExitRequested) return;
        if (
          snapshot.state !== 'recharge' &&
          snapshot.state !== 'paywall_followup' &&
          snapshot.state !== 'chat'
        )
          return;
        if (ready) {
          rechargeUserId = rechargeUserId || adapter().getDistinctId() || null;
          if (!identity) adapter().clearReplaySessionProperties();
          adapter().resumeRecording(contextId);
          adapter().registerSessionProperties(sessionProperties());
        }
        rechargeStarting = false;
        const drafts = pendingRechargeEvents.splice(0);
        if (ready) drafts.forEach((draft) => capture(draft));
      });
    }
    armIdleTimer();
  }

  function enterPaywallFollowup(): Promise<void> {
    paywallHold = true;
    if (snapshot.state === 'external_payment_pending') {
      return Promise.resolve();
    }
    return enqueue(() => {
      if (snapshot.state === 'external_payment_pending') return;
      if (snapshot.state !== 'chat' && snapshot.state !== 'paywall_followup') return;
      setState('paywall_followup');
      armIdleTimer();
    });
  }

  function enterExternalPaymentPending(): Promise<void> {
    if (
      snapshot.state !== 'chat' &&
      snapshot.state !== 'recharge' &&
      snapshot.state !== 'paywall_followup' &&
      snapshot.state !== 'external_payment_pending'
    ) {
      return Promise.resolve();
    }
    paywallHold = true;
    setState('external_payment_pending');
    clearIdleTimer();
    if (!identity && rechargeStarting) rechargeStartGeneration += 1;
    adapter().stopRecording(snapshot.replayContextId ?? undefined);
    return Promise.resolve();
  }

  function reenterChatFromFollowup(): void {
    if (!identity) return;
    if (snapshot.state !== 'paywall_followup' && snapshot.state !== 'external_payment_pending') {
      return;
    }
    if (snapshot.state === 'external_payment_pending' && identity) resumePaymentReplay();
    paywallHold = false;
    setState('chat');
    armIdleTimer();
  }

  async function endReplay(reason: ReplayChatEndReason): Promise<void> {
    if (
      !identity &&
      (snapshot.state === 'recharge' || snapshot.state === 'external_payment_pending')
    ) {
      rechargeExitRequested = true;
    }
    await enqueue(() => {
      if (snapshot.state === 'idle' || snapshot.state === 'ended') return;
      if (
        (reason === 'route_change' || reason === 'pagehide') &&
        identity &&
        isPaywallContinuationActive()
      ) {
        return;
      }
      paywallHold = false;
      clearIdleTimer();
      captureEnded(reason);
      adapter().stopRecording(snapshot.replayContextId ?? undefined);
      // PostHog 会把 session super properties 自动合并到后续事件。
      // 结束事件已发出后再清理，避免个人中心主动充值误继承旧聊天 context。
      adapter().clearReplaySessionProperties();
      identity = null;
      rechargeUserId = null;
      pendingRechargeEvents.length = 0;
      rechargeStarting = false;
      rechargeStartGeneration += 1;
      rechargeResumeMode = false;
      rechargeExitRequested = false;
      userTags = {};
      snapshot = {
        state: 'ended',
        replayContextId: null,
        telemetryReady: adapter().isReady(),
        streaming: false,
      };
      emit();
    });
  }

  function attachWindowListeners(): void {
    if (attached) return;
    attached = true;
    addWindowListener('pagehide', pageHideListener);
    addWindowListener('pointerdown', activityListener);
    addWindowListener('keydown', activityListener);
    addWindowListener('scroll', activityListener);
    addWindowListener('touchstart', activityListener);
  }

  function detachWindowListeners(): void {
    if (!attached) return;
    attached = false;
    removeWindowListener('pagehide', pageHideListener);
    removeWindowListener('pointerdown', activityListener);
    removeWindowListener('keydown', activityListener);
    removeWindowListener('scroll', activityListener);
    removeWindowListener('touchstart', activityListener);
  }

  function capture(draft: ReplayEventDraft): boolean {
    if (
      !snapshot.replayContextId ||
      (!identity && snapshot.state !== 'recharge' && snapshot.state !== 'external_payment_pending')
    )
      return false;
    if (rechargeStarting) {
      if (pendingRechargeEvents.length >= 32) return false;
      pendingRechargeEvents.push(draft);
      return true;
    }
    return adapter().capture(
      omitUndefined({
        ...draft,
        telegram_user_id: identity?.telegramUserId || rechargeUserId || adapter().getDistinctId(),
        replay_context_id: snapshot.replayContextId,
        occurred_at: draft.occurred_at ?? now().toISOString(),
        is_paid_user: draft.is_paid_user ?? userTags.is_paid_user,
        total_chat_rounds: draft.total_chat_rounds ?? userTags.total_chat_rounds,
      })
    );
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(): ReplayLifecycleSnapshot {
      return snapshot;
    },
    getState(): ReplayLifecycleState {
      return snapshot.state;
    },
    isStandaloneRecharge(): boolean {
      return (
        !identity &&
        (snapshot.state === 'recharge' || snapshot.state === 'external_payment_pending')
      );
    },
    isPaywallContinuationActive,
    refreshTelemetryReady(): void {
      const distinctId = adapter().getDistinctId();
      if (identity && !identity.telegramUserId && distinctId) {
        identity = { ...identity, telegramUserId: distinctId };
      }
      snapshot = { ...snapshot, telemetryReady: adapter().isReady() };
      emit();
      armRecordingIfNeeded();
    },
    attachWindowListeners,
    detachWindowListeners,
    startChatReplay,
    startRechargeReplay,
    restorePaymentReplay,
    resumePaymentReplay,
    enterPaywallFollowup,
    enterExternalPaymentPending,
    reenterChatFromFollowup,
    endReplay,
    notifyUserActivity,
    setStreaming(active: boolean): void {
      snapshot = { ...snapshot, streaming: active, telemetryReady: adapter().isReady() };
      emit();
      if (active) {
        clearIdleTimer();
        return;
      }
      armIdleTimer();
    },
    updateSessionProperties(input: Partial<StartChatReplayInput>): void {
      if (!identity) return;
      identity = {
        ...identity,
        characterId: input.characterId ?? identity.characterId,
        conversationSessionId: input.conversationSessionId ?? identity.conversationSessionId,
        selectedModelId:
          input.selectedModelId === undefined ? identity.selectedModelId : input.selectedModelId,
      };
      adapter().registerSessionProperties(sessionProperties());
    },
    applyUserTags(data: GetReplayContextData): void {
      const expected = adapter().getDistinctId();
      if (expected && data.telegram_user_id !== expected) return;
      userTags = {
        is_paid_user: data.is_paid_user,
        total_chat_rounds: data.total_chat_rounds,
      };
      adapter().setPersonProperties({
        is_paid_user: data.is_paid_user,
        total_chat_rounds: data.total_chat_rounds,
      });
      adapter().registerSessionProperties(
        omitUndefined({
          ...sessionProperties(),
          is_paid_user: data.is_paid_user,
          total_chat_rounds: data.total_chat_rounds,
        })
      );
    },
    reportContextFetchFailed(): void {
      const contextId = snapshot.replayContextId;
      if (!contextId || contextFetchFailedFor === contextId) return;
      contextFetchFailedFor = contextId;
      adapter().reportHealth('replay_sdk_init_failed', 'context_fetch_failed', contextId);
    },
    capture,
  };
}

export type ReplayLifecycleApi = ReturnType<typeof createReplayLifecycle>;

let lifecycle: ReplayLifecycleApi | undefined;

export function getReplayLifecycle(): ReplayLifecycleApi {
  if (!lifecycle) lifecycle = createReplayLifecycle();
  return lifecycle;
}

export function resetReplayLifecycleForTests(next?: ReplayLifecycleApi): void {
  lifecycle = next;
}

export function useReplayLifecycle(): ReplayLifecycleApi {
  return getReplayLifecycle();
}
