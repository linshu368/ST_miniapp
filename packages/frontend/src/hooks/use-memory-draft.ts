'use client';

import { useCallback, type SetStateAction } from 'react';
import { getRawInitData } from '@/lib/telegram/auth';
import { parseTelegramUser } from '@/lib/telegram/user';
import { activeMemoryDraft, useMemoryDraftStore } from '@/stores/memory-draft-store';

/** 会话与模块独立；仅在当前应用中恢复文字，不自动发送或保留上传文件。 */
export function useMemoryDraft(key: string | null, initialValue = '') {
  const userId = typeof window === 'undefined' ? undefined : parseTelegramUser(getRawInitData()).id;
  const scopedKey = key ? `${userId ?? 'local'}:${key}` : null;
  const entry = useMemoryDraftStore((state) => (scopedKey ? state.entries[scopedKey] : undefined));
  const active = activeMemoryDraft(entry);
  const value = active?.text ?? initialValue;
  const revision = active?.revision ?? null;

  const setValue = useCallback(
    (next: SetStateAction<string>) => {
      if (!scopedKey) return;
      const store = useMemoryDraftStore.getState();
      const previous = activeMemoryDraft(store.entries[scopedKey])?.text ?? initialValue;
      store.write(scopedKey, typeof next === 'function' ? next(previous) : next);
    },
    [scopedKey, initialValue]
  );

  const clearIfUnchanged = useCallback(
    (submittedValue: string) => {
      if (scopedKey) {
        useMemoryDraftStore
          .getState()
          .clearIfUnchanged(scopedKey, submittedValue, revision, initialValue);
      }
    },
    [scopedKey, revision, initialValue]
  );

  return { value, setValue, hasDraft: active !== undefined, clearIfUnchanged };
}
