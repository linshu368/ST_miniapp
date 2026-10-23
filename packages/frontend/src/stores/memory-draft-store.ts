'use client';

import { create } from 'zustand';

const MAX_DRAFTS = 64;
export const MEMORY_DRAFT_TTL_MS = 2 * 60 * 60_000;

interface DraftEntry {
  text: string;
  revision: number;
  updatedAt: number;
}

interface MemoryDraftState {
  entries: Record<string, DraftEntry>;
  revision: number;
  write: (key: string, text: string) => void;
  clearIfUnchanged: (key: string, text: string, revision: number | null, fallback: string) => void;
}

export function activeMemoryDraft(entry: DraftEntry | undefined): DraftEntry | undefined {
  return entry && Date.now() - entry.updatedAt < MEMORY_DRAFT_TTL_MS ? entry : undefined;
}

function nextEntries(entries: Record<string, DraftEntry>, key: string, entry: DraftEntry) {
  const recent = Object.entries(entries)
    .filter(([id, value]) => id !== key && activeMemoryDraft(value))
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_DRAFTS - 1);
  return { ...Object.fromEntries(recent), [key]: entry };
}

/** 草稿只留在当前应用内存，不落盘或上报；空文本也有版本，避免旧快照重新填回。 */
export const useMemoryDraftStore = create<MemoryDraftState>((set) => ({
  entries: {},
  revision: 0,
  write: (key, text) =>
    set((state) => {
      const revision = state.revision + 1;
      return {
        revision,
        entries: nextEntries(state.entries, key, { text, revision, updatedAt: Date.now() }),
      };
    }),
  clearIfUnchanged: (key, text, expectedRevision, fallback) =>
    set((state) => {
      const current = activeMemoryDraft(state.entries[key]);
      // 同时核对身份、文本与编辑版本：A→B→A 也属于用户继续编辑，旧请求不能清空它。
      if (
        (current?.revision ?? null) !== expectedRevision ||
        (current?.text ?? fallback) !== text
      ) {
        return state;
      }
      const revision = state.revision + 1;
      return {
        revision,
        entries: nextEntries(state.entries, key, { text: '', revision, updatedAt: Date.now() }),
      };
    }),
}));
