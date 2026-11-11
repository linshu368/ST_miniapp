import type { FastifyInstance } from 'fastify';
import { ChatSessionRepository } from '../infrastructure/repositories/ChatSessionRepository.js';
import { ConversationHistoryRepository } from '../infrastructure/repositories/ConversationHistoryRepository.js';
import { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
import { registerConversationDetail } from './conversation-detail.js';
import {
  registerConversationGetConfig,
  registerConversationPatchConfig,
  registerConversationRegenerate,
  registerConversationSend,
} from './conversation-generation.js';
import {
  registerConversationBranch,
  registerConversationCancel,
  registerConversationEditMessage,
  registerConversationFirstToken,
  registerConversationLike,
} from './conversation-interactions.js';
import {
  registerConversationCreate,
  registerConversationDelete,
  registerConversationList,
  registerConversationUpdate,
} from './conversation-sessions.js';
export { isValidConversationRequestId } from './conversation-generation.js';

export default async function conversationRoutes(app: FastifyInstance) {
  const repositories = {
    sessions: new ChatSessionRepository(),
    history: new ConversationHistoryRepository(),
    settings: new MiniappUserSettingsRepository(),
  };
  registerConversationCancel(app, repositories);
  registerConversationFirstToken(app, repositories);
  registerConversationLike(app, repositories);
  registerConversationBranch(app, repositories);
  registerConversationEditMessage(app, repositories);
  registerConversationCreate(app, repositories);
  registerConversationList(app, repositories);
  registerConversationDetail(app, repositories);
  registerConversationUpdate(app, repositories);
  registerConversationDelete(app, repositories);
  registerConversationSend(app, repositories);
  registerConversationRegenerate(app, repositories);
  registerConversationGetConfig(app, repositories);
  registerConversationPatchConfig(app, repositories);
}
