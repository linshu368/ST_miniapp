import {
  GetChatFeedbackDataSchema,
  SaveChatFeedbackDataSchema,
  type SaveChatFeedbackRequest,
} from '@miniapp/shared';
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';

export class ChatFeedbackError extends Error {
  constructor(readonly code: string) {
    super('Chat feedback database operation failed');
  }
}
export class ChatFeedbackRepository {
  constructor(private readonly database?: DomainDb) {}
  private get db() {
    return this.database ?? getDomainDb('experience');
  }
  async get(userId: string, sessionId: string, messageId: string, version: number) {
    const { data, error } = await this.db
      .rpc('get_chat_reply_feedback', {
        p_user_id: userId,
        p_session_id: sessionId,
        p_message_id: messageId,
        p_edit_version: version,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw new ChatFeedbackError(error.code);
    return GetChatFeedbackDataSchema.parse(data);
  }
  async save(userId: string, sessionId: string, messageId: string, body: SaveChatFeedbackRequest) {
    const { data, error } = await this.db
      .rpc('save_chat_reply_feedback', {
        p_user_id: userId,
        p_session_id: sessionId,
        p_message_id: messageId,
        p_expected_version: body.expected_version,
        p_reasons: body.reasons,
        p_detail: body.detail,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw new ChatFeedbackError(error.code);
    const result = SaveChatFeedbackDataSchema.parse(data);
    if (
      result.feedback.session_id !== sessionId ||
      result.feedback.message_id !== messageId ||
      result.feedback.edit_version !== body.expected_version
    )
      throw new Error('Feedback response identity mismatch');
    return result;
  }
}
