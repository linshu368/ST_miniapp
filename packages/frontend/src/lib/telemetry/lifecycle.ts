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
  let userTags: UserTags = {};
  let queue: Promise<void> = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let attached = false;
  let contextFetchFailedFor: string | null = null;

  const activityListener: EventListener = () => {
    notifyUserActivity();
  };

  const pageHideListener: EventListener = () => {
    const state = snapshot.state;
    if (state === 'paywall_followup' || state === 'external_payment_pending') return;
    if (state !== 'chat') return;
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
    return snapshot.state === 'chat' || snapshot.state === 'paywall_followup';
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
    if (!identity || !snapshot.replayContextId) return {};
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

  async function startChatReplay(input: StartChatReplayInput): Promise<string | null> {
    await enqueue(async () => {
      const telegramUserId = adapter().getDistinctId();
      if (
        snapshot.state === 'chat' &&
        identity &&
        identity.characterId === input.characterId &&
        identity.conversationSessionId === input.conversationSessionId
      ) {
        identity = { ...identity, selectedModelId: input.selectedModelId };
        adapter().registerSessionProperties(sessionProperties());
        return;
      }

      if (snapshot.state === 'chat' || snapshot.state === 'paywall_followup') {
        captureEnded('route_change');
        adapter().stopRecording(snapshot.replayContextId ?? undefined);
      } else if (snapshot.state === 'external_payment_pending') {
        adapter().stopRecording(snapshot.replayContextId ?? undefined);
      }

      const replayContextId = makeId();
      identity = {
        telegramUserId: telegramUserId ?? '',
        characterId: input.characterId,
        conversationSessionId: input.conversationSessionId,
        selectedModelId: input.selectedModelId,
      };
      userTags = {};
      contextFetchFailedFor = null;
      snapshot = {
        state: 'chat',
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

  async function enterPaywallFollowup(): Promise<void> {
    await enqueue(() => {
      if (snapshot.state !== 'chat' && snapshot.state !== 'paywall_followup') return;
      setState('paywall_followup');
      armIdleTimer();
    });
  }

  async function enterExternalPaymentPending(): Promise<void> {
    await enqueue(() => {
      if (
        snapshot.state !== 'chat' &&
        snapshot.state !== 'paywall_followup' &&
        snapshot.state !== 'external_payment_pending'
      ) {
        return;
      }
      setState('external_payment_pending');
      clearIdleTimer();
    });
  }

  async function endReplay(reason: ReplayChatEndReason): Promise<void> {
    await enqueue(() => {
      if (snapshot.state === 'idle' || snapshot.state === 'ended') return;
      clearIdleTimer();
      captureEnded(reason);
      adapter().stopRecording(snapshot.replayContextId ?? undefined);
      identity = null;
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
    refreshTelemetryReady(): void {
      const distinctId = adapter().getDistinctId();
      if (identity && !identity.telegramUserId && distinctId) {
        identity = { ...identity, telegramUserId: distinctId };
      }
      snapshot = { ...snapshot, telemetryReady: adapter().isReady() };
      emit();
    },
    attachWindowListeners,
    detachWindowListeners,
    startChatReplay,
    enterPaywallFollowup,
    enterExternalPaymentPending,
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
    capture(draft: ReplayEventDraft): void {
      if (!identity || !snapshot.replayContextId) return;
      adapter().capture(
        omitUndefined({
          ...draft,
          telegram_user_id: identity.telegramUserId,
          replay_context_id: snapshot.replayContextId,
          occurred_at: draft.occurred_at ?? now().toISOString(),
          is_paid_user: draft.is_paid_user ?? userTags.is_paid_user,
          total_chat_rounds: draft.total_chat_rounds ?? userTags.total_chat_rounds,
        })
      );
    },
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
