import { create } from 'zustand';
import type { UserChatListItem } from '@miniapp/shared';
import { fetchUserChats } from '@/lib/api/chats';

interface ChatListStore {
  items: UserChatListItem[];
  loading: boolean;
  error: string | null;
  lastFetchedAt: number;

  fetch: () => Promise<void>;
  invalidate: () => void;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 400;

export const useChatListStore = create<ChatListStore>((set, get) => ({
  items: [],
  loading: false,
  error: null,
  lastFetchedAt: 0,

  fetch: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const data = await fetchUserChats();
      set({ items: data.items, loading: false, lastFetchedAt: Date.now() });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load chats',
        loading: false,
      });
    }
  },

  invalidate: () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      get().fetch();
    }, DEBOUNCE_MS);
  },
}));
