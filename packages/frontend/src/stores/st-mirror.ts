import { create } from 'zustand';
import type { STMirrorState } from '@miniapp/bridge-protocol';

type STMirrorStore = STMirrorState & {
  updatePartial: (patch: Partial<STMirrorState>) => void;
  reset: () => void;
};

const initialState: STMirrorState = {
  userId: '',
  currentCharacterId: null,
  currentChatId: null,
  currentPresetName: null,
  currentModel: null,
  generationPhase: 'idle',
  messageCount: 0,
  lastUpdatedAt: 0,
};

export const useSTMirrorStore = create<STMirrorStore>((set) => ({
  ...initialState,
  updatePartial: (patch) => set((state) => ({ ...state, ...patch, lastUpdatedAt: Date.now() })),
  reset: () => set(initialState),
}));
