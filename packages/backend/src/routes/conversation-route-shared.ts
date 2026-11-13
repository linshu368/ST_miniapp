import type { ChatFolderRepository } from '../infrastructure/repositories/ChatFolderRepository.js';
import type { ChatSessionRepository } from '../infrastructure/repositories/ChatSessionRepository.js';
import type { ConversationHistoryRepository } from '../infrastructure/repositories/ConversationHistoryRepository.js';
import type { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
export interface ConversationRouteRepositories {
  sessions: ChatSessionRepository;
  history: ConversationHistoryRepository;
  settings: MiniappUserSettingsRepository;
  folders: ChatFolderRepository;
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}
