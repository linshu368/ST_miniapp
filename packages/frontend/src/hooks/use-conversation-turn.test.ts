import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@miniapp/shared';

import { ConversationStreamError } from '@/lib/api/conversation-stream';

import {
  classifyChatTurnFailure,
  estimateChatTurnTelemetry,
  toTelemetryRevision,
} from './use-conversation-turn';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

function message(
  partial: Partial<ChatMessage> & Pick<ChatMessage, 'turn_index' | 'revision'>
): ChatMessage {
  return {
    id: 'm1',
    session_id: '33333333-3333-4333-8333-333333333333',
    role: 'assistant',
    content: 'hi',
    status: 'complete',
    error_code: null,
    finish_reason: 'stop',
    model_id: null,
    created_at: '2026-09-15T10:00:00.000Z',
    ...partial,
  };
}

describe('toTelemetryRevision', () => {
  it('projects domain revision 0 to 1 so the shared contract accepts it', () => {
    expect(toTelemetryRevision(0)).toBe(1);
    expect(toTelemetryRevision(1)).toBe(1);
    expect(toTelemetryRevision(3)).toBe(3);
  });
});

describe('estimateChatTurnTelemetry', () => {
  it('starts the next send after the last persisted turn', () => {
    expect(
      estimateChatTurnTelemetry({
        mode: 'send',
        messages: [message({ turn_index: 0, revision: 0, role: 'assistant' })],
      })
    ).toEqual({ turnIndex: 1, revision: 1 });
    expect(
      estimateChatTurnTelemetry({
        mode: 'send',
        messages: [message({ turn_index: 4, revision: 0 })],
      })
    ).toEqual({ turnIndex: 5, revision: 1 });
  });

  it('keeps regenerate on the last user turn and bumps revision', () => {
    expect(
      estimateChatTurnTelemetry({
        mode: 'regenerate',
        messages: [message({ turn_index: 2, revision: 0 })],
      })
    ).toEqual({ turnIndex: 2, revision: 1 });
    expect(
      estimateChatTurnTelemetry({
        mode: 'regenerate',
        messages: [message({ turn_index: 2, revision: 2 })],
      })
    ).toEqual({ turnIndex: 2, revision: 3 });
  });
});

describe('classifyChatTurnFailure', () => {
  it('maps credit and conversation business codes to business', () => {
    expect(
      classifyChatTurnFailure(new ConversationStreamError('余额不足', 402, 'insufficient_balance'))
    ).toBe('business');
    expect(
      classifyChatTurnFailure(new ConversationStreamError('会话忙', 409, 'session_busy'))
    ).toBe('business');
  });

  it('maps timeout names/status and treats other fetch failures as network', () => {
    expect(
      classifyChatTurnFailure(new ConversationStreamError('超时', 504, 'upstream_error'))
    ).toBe('timeout');
    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';
    expect(classifyChatTurnFailure(timeout)).toBe('timeout');
    expect(classifyChatTurnFailure(new TypeError('Failed to fetch'))).toBe('network');
  });

  it('does not put error bodies into the classification result', () => {
    const error = new ConversationStreamError('secret body', 502, 'upstream_error');
    expect(classifyChatTurnFailure(error)).toBe('unknown');
  });
});
