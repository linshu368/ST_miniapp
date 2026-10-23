'use client';

import { create } from 'zustand';

interface FavoriteNotice {
  id: number;
  characterId: string;
  message: string;
}

interface FavoriteFeedbackState {
  notice: FavoriteNotice | null;
  showFailure: (characterId: string, favorited: boolean) => void;
  dismiss: (id: number) => void;
  clearForCharacter: (characterId: string) => void;
}

let noticeSequence = 0;

/** A single short-lived favorite error. No text input or persistent browser storage. */
export const useFavoriteFeedbackStore = create<FavoriteFeedbackState>((set) => ({
  notice: null,
  showFailure: (characterId, favorited) =>
    set({
      notice: {
        id: ++noticeSequence,
        characterId,
        message: favorited ? '收藏没能保存，请再试一次。' : '取消收藏未成功，请再试一次。',
      },
    }),
  dismiss: (id) => set((state) => (state.notice?.id === id ? { notice: null } : state)),
  clearForCharacter: (characterId) =>
    set((state) => (state.notice?.characterId === characterId ? { notice: null } : state)),
}));
