import { describe, expect, it } from 'vitest';
import { SaveChatFeedbackRequestSchema } from './chat-feedback';

describe('private reply feedback contract', () => {
  it('accepts a negative vote without reasons or details', () => {
    expect(SaveChatFeedbackRequestSchema.parse({ expected_version: 0 })).toEqual({
      expected_version: 0,
      reasons: [],
      detail: '',
    });
  });
  it.each([
    { expected_version: -1 },
    { expected_version: 0, reasons: ['invented'] },
    { expected_version: 0, reasons: ['other', 'other'] },
    { expected_version: 0, detail: 'x'.repeat(501) },
    { expected_version: 0, user_id: 'forged' },
    { expected_version: 0, assistant_reply: 'forged' },
  ])('rejects invalid or forged metadata %j', (body) => {
    expect(SaveChatFeedbackRequestSchema.safeParse(body).success).toBe(false);
  });
});
