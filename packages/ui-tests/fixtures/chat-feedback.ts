import { randomUUID } from 'node:crypto';
import {
  SaveChatFeedbackRequestSchema,
  type ChatFeedback,
  type ChatMessage,
} from '@miniapp/shared';

export function createChatFeedbackFixture() {
  const records = new Map<string, ChatFeedback>();
  let failed = false;
  return {
    reset() {
      records.clear();
      failed = false;
    },
    handle(
      method: string,
      sessionId: string,
      message: ChatMessage | undefined,
      version: number,
      body: unknown,
      simulateFailure: boolean
    ) {
      if (
        !message ||
        message.status !== 'complete' ||
        message.deleted ||
        message.role !== 'assistant'
      )
        return { status: 409, code: 'REPLY_CHANGED', message: '回复已变更' };
      if (method === 'GET')
        return {
          status: 200,
          data: { feedback: records.get(`${sessionId}:${message.id}:${version}`) ?? null },
        };
      const parsed = SaveChatFeedbackRequestSchema.safeParse(body);
      if (!parsed.success) return { status: 400, code: 'BAD_REQUEST', message: '反馈内容无效' };
      if ((message.edit_version ?? 0) !== parsed.data.expected_version)
        return { status: 409, code: 'REPLY_CHANGED', message: '回复已变更' };
      const key = `${sessionId}:${message.id}:${parsed.data.expected_version}`;
      const previous = records.get(key);
      const feedback: ChatFeedback = {
        id: previous?.id ?? randomUUID(),
        session_id: sessionId,
        message_id: message.id,
        edit_version: parsed.data.expected_version,
        reasons: parsed.data.reasons,
        detail: parsed.data.detail,
        created_at: previous?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      records.set(key, feedback);
      // Deliberately lose the first response after saving, to test safe retries.
      if (simulateFailure && !failed) {
        failed = true;
        return {
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          message: '反馈暂未保存，请重试，填写的内容还在',
        };
      }
      return { status: 200, data: { feedback } };
    },
  };
}
