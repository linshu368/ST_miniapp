import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@miniapp/shared';
import {
  beginActiveDelivery,
  appendActiveDelivery,
  endActiveDelivery,
  recoverActiveDelivery,
} from './active-delivery.js';
const message: ChatMessage = {
  id: 'delivery-test',
  session_id: 'session',
  turn_index: 1,
  revision: 2,
  role: 'assistant',
  content: '',
  status: 'streaming',
  error_code: null,
  finish_reason: null,
  model_id: 'model',
  created_at: '',
};
afterEach(() => {
  endActiveDelivery(message.id);
  vi.useRealTimers();
});
describe('return to an active reply', () => {
  it('recovers body and public thinking without restarting generation or leaking another revision/user', () => {
    beginActiveDelivery(message.id, 'user', 'session', 2);
    appendActiveDelivery(message.id, 'reasoning', '正在想');
    appendActiveDelivery(message.id, 'delta', '回复');
    expect(recoverActiveDelivery([message], 'user', 'session')[0]).toMatchObject({
      content: '回复',
      reasoning: '正在想',
    });
    expect(recoverActiveDelivery([message], 'another', 'session')[0]).toEqual(message);
    expect(
      recoverActiveDelivery([{ ...message, revision: 3 }], 'user', 'session')[0]?.content
    ).toBe('');
    expect(recoverActiveDelivery([message], 'user', 'different')[0]).toEqual(message);
  });
  it('never replaces the persisted terminal winner and expires bounded live snapshots', () => {
    vi.useFakeTimers();
    beginActiveDelivery(message.id, 'user', 'session', 2);
    appendActiveDelivery(message.id, 'delta', 'old');
    const final = { ...message, status: 'complete' as const, content: 'final' };
    expect(recoverActiveDelivery([final], 'user', 'session')[0]).toEqual(final);
    vi.advanceTimersByTime(125001);
    expect(recoverActiveDelivery([message], 'user', 'session')[0]).toEqual(message);
  });
});
