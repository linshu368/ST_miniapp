import type { STMirrorState, GenerationPhase } from '@miniapp/bridge-protocol';
import './st-types.js';

let _boundUserId: string = '';
let _generationPhase: GenerationPhase = 'idle';

export function setBoundUserId(userId: string): void {
  _boundUserId = userId;
}

export function setGenerationPhase(phase: GenerationPhase): void {
  _generationPhase = phase;
}

export function getGenerationPhase(): GenerationPhase {
  return _generationPhase;
}

export function buildMirrorState(): STMirrorState {
  const ctx = SillyTavern.getContext();
  return {
    userId: _boundUserId,
    currentCharacterId: ctx.characterId ?? null,
    currentChatId: ctx.getCurrentChatId() ?? null,
    currentPresetName: ctx.getPresetManager()?.getSelectedPresetName() ?? null,
    generationPhase: _generationPhase,
    messageCount: ctx.chat?.length ?? 0,
    lastUpdatedAt: Date.now(),
  };
}
