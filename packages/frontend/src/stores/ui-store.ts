'use client';

import { create } from 'zustand';

// 示例：管理跨组件的 UI 状态（当前选中角色、侧边栏开合等）。
// 规则：能用 useState 解决就别往这里塞；只有跨组件共享才用 Zustand。

interface UIState {
  selectedCharacterId: string | undefined;
  sidebarOpen: boolean;
  activeCharacterAvatar: string | null;
  setSelectedCharacterId: (id: string | undefined) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setActiveCharacterAvatar: (avatar: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  selectedCharacterId: undefined,
  sidebarOpen: false,
  activeCharacterAvatar: null,
  setSelectedCharacterId: (id) => set({ selectedCharacterId: id }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setActiveCharacterAvatar: (avatar) => set({ activeCharacterAvatar: avatar }),
}));
