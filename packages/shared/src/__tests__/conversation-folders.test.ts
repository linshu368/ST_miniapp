import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_BATCH_LIMIT,
  ChatFolderNameSchema,
  ConversationBatchRequestSchema,
} from '../api/conversation-folders';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('conversation folder contracts', () => {
  it('trims folder names and enforces 1–12 characters', () => {
    expect(ChatFolderNameSchema.parse('  主线剧情 ')).toBe('主线剧情');
    expect(ChatFolderNameSchema.safeParse('   ').success).toBe(false);
    expect(ChatFolderNameSchema.safeParse('一二三四五六七八九十一二三').success).toBe(false);
  });

  it('caps a batch at the server limit and requires folder_id for move', () => {
    const ids = Array.from({ length: CONVERSATION_BATCH_LIMIT + 1 }, (_, n) => id(n + 1));
    expect(
      ConversationBatchRequestSchema.safeParse({ session_ids: ids, action: 'pin' }).success
    ).toBe(false);
    expect(
      ConversationBatchRequestSchema.safeParse({ session_ids: [id(1)], action: 'move' }).success
    ).toBe(false);
    expect(
      ConversationBatchRequestSchema.safeParse({
        session_ids: [id(1)],
        action: 'move',
        folder_id: null,
      }).success
    ).toBe(true);
    expect(
      ConversationBatchRequestSchema.safeParse({ session_ids: [id(1)], action: 'archive' }).success
    ).toBe(false);
  });
});
