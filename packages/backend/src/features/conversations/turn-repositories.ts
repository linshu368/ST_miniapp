import { CharacterCardRepository } from '../../infrastructure/repositories/CharacterCardRepository.js';
import { ConversationHistoryRepository } from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import { GenerationObservationRepository } from '../../infrastructure/repositories/GenerationObservationRepository.js';
import { MiniappUserSettingsRepository } from '../../infrastructure/repositories/MiniappUserSettingsRepository.js';

// 一轮生成各阶段共用的仓库实例。懒创建，测试按模块路径 mock 仓库类即可替换。
let historyRepository: ConversationHistoryRepository | null = null;
let characterRepository: CharacterCardRepository | null = null;
let userSettingsRepository: MiniappUserSettingsRepository | null = null;

export const generationObservations = () => new GenerationObservationRepository();

export function historyRecords(): ConversationHistoryRepository {
  return (historyRepository ??= new ConversationHistoryRepository());
}
export function characters(): CharacterCardRepository {
  return (characterRepository ??= new CharacterCardRepository());
}
export function userSettings(): MiniappUserSettingsRepository {
  return (userSettingsRepository ??= new MiniappUserSettingsRepository());
}
