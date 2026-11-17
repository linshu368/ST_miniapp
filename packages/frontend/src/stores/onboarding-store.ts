'use client';

import { create } from 'zustand';
import type { UserOnboardingData } from '@miniapp/shared';

export interface GuideProgress {
  expiresAt: number;
  skipped: boolean;
  started: boolean;
  replied: boolean;
  toolsSeen: boolean;
  returned: boolean;
  creatorInvite?: 'shown' | 'dismissed' | 'accepted';
  creatorStarted?: boolean;
  creatorIntroSeen?: boolean;
  completedTurns?: string[];
}
export const guideStorageKey = (scope: string) => `miniapp:guide:v1:${scope}`;
export function parseGuideProgress(raw: string | null): GuideProgress | undefined {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (
      !value ||
      typeof value !== 'object' ||
      !('expiresAt' in value) ||
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt)
    )
      return;
    for (const key of ['skipped', 'started', 'replied', 'toolsSeen', 'returned'] as const)
      if (!(key in value) || typeof value[key as keyof typeof value] !== 'boolean') return;
    const progress = value as GuideProgress;
    if (
      progress.creatorInvite !== undefined &&
      !['shown', 'dismissed', 'accepted'].includes(progress.creatorInvite)
    )
      return;
    for (const field of ['creatorStarted', 'creatorIntroSeen'] as const)
      if (progress[field] !== undefined && typeof progress[field] !== 'boolean') return;
    if (
      progress.completedTurns !== undefined &&
      (!Array.isArray(progress.completedTurns) ||
        progress.completedTurns.length > 10 ||
        progress.completedTurns.some((id) => typeof id !== 'string' || id.length > 160))
    )
      return;
    if (progress.completedTurns) progress.completedTurns = [...new Set(progress.completedTurns)];
    return progress;
  } catch {
    return;
  }
}

export function isNewcomerProgress(progress: GuideProgress | undefined, now = Date.now()) {
  return Boolean(progress && progress.expiresAt > now);
}

export function isBasicGuideFinished(progress: GuideProgress | undefined) {
  return Boolean(progress && (progress.skipped || (progress.toolsSeen && progress.returned)));
}

export type GuideUpdate = Partial<
  Pick<
    GuideProgress,
    | 'skipped'
    | 'started'
    | 'replied'
    | 'toolsSeen'
    | 'returned'
    | 'creatorInvite'
    | 'creatorStarted'
    | 'creatorIntroSeen'
  >
>;
export function isGuideActive(progress: GuideProgress | undefined, now = Date.now()): boolean {
  return Boolean(
    progress &&
    !progress.skipped &&
    progress.expiresAt > now &&
    !(progress.toolsSeen && progress.returned)
  );
}

interface GuideStore {
  accounts: Record<string, GuideProgress | undefined>;
  hydrated: Record<string, boolean>;
  creatorReturns: Record<string, boolean>;
  armCreatorReturn: (scope: string) => void;
  takeCreatorReturn: (scope: string) => boolean;
  recordCompletedTurn: (scope: string, id: string) => void;
  hydrate: (scope: string) => void;
  enroll: (scope: string, data: UserOnboardingData) => void;
  update: (scope: string, patch: GuideUpdate) => void;
}
function persist(scope: string, value: GuideProgress) {
  try {
    window.localStorage.setItem(guideStorageKey(scope), JSON.stringify(value));
  } catch {
    // Privacy mode: keep the in-memory dismissal for this document.
  }
}
export const useOnboardingStore = create<GuideStore>((set, get) => ({
  accounts: {},
  hydrated: {},
  creatorReturns: {},
  recordCompletedTurn(scope, id) {
    const previous = get().accounts[scope];
    if (
      !previous ||
      !isNewcomerProgress(previous) ||
      previous.creatorInvite ||
      previous.creatorStarted
    )
      return;
    const turns = previous.completedTurns ?? [];
    if (turns.length >= 10 || turns.includes(id)) return;
    const value = { ...previous, completedTurns: [...turns, id] };
    persist(scope, value);
    set((state) => ({ accounts: { ...state.accounts, [scope]: value } }));
  },
  armCreatorReturn(scope) {
    const state = get();
    const progress = state.accounts[scope];
    if (
      !isNewcomerProgress(progress) ||
      progress?.creatorInvite ||
      progress?.creatorStarted ||
      state.creatorReturns[scope]
    )
      return;
    set({ creatorReturns: { ...state.creatorReturns, [scope]: true } });
  },
  takeCreatorReturn(scope) {
    if (!get().creatorReturns[scope]) return false;
    set((state) => ({ creatorReturns: { ...state.creatorReturns, [scope]: false } }));
    return true;
  },
  hydrate(scope) {
    if (get().hydrated[scope]) return;
    let value: GuideProgress | undefined;
    try {
      value = parseGuideProgress(window.localStorage.getItem(guideStorageKey(scope)));
    } catch {
      /* optional storage */
    }
    set((state) => ({
      accounts: { ...state.accounts, [scope]: value },
      hydrated: { ...state.hydrated, [scope]: true },
    }));
  },
  enroll(scope, data) {
    if (get().accounts[scope]) return;
    const value: GuideProgress = {
      expiresAt: data.eligible && data.expires_at ? Date.parse(data.expires_at) : 0,
      skipped: !data.eligible,
      started: false,
      replied: false,
      toolsSeen: false,
      returned: false,
    };
    persist(scope, value);
    set((state) => ({ accounts: { ...state.accounts, [scope]: value } }));
  },
  update(scope, patch) {
    const previous = get().accounts[scope];
    if (
      !previous ||
      Object.entries(patch).every(([key, value]) => previous[key as keyof GuideProgress] === value)
    )
      return;
    const value = { ...previous, ...patch, skipped: previous.skipped || patch.skipped === true };
    persist(scope, value);
    set((state) => ({ accounts: { ...state.accounts, [scope]: value } }));
  },
}));
