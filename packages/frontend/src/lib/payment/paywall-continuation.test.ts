import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  chatIdentityFromReturnTo,
  PAYWALL_CONTINUATION_TTL_MS,
  readPaywallContinuation,
  writePaywallContinuation,
} from './paywall-continuation';
import { setReplaySessionStorageForTests } from './session-storage';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

const characterId = '22222222-2222-4222-8222-222222222222';
const conversationSessionId = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  setReplaySessionStorageForTests(memoryStorage());
});

afterEach(() => {
  setReplaySessionStorageForTests(undefined);
});

describe('paywall continuation', () => {
  it('parses chat identity from returnTo and stores continuation off the URL', () => {
    expect(
      chatIdentityFromReturnTo(`/chat/${characterId}?session=${conversationSessionId}`)
    ).toEqual({ characterId, conversationSessionId });
    expect(chatIdentityFromReturnTo('/chat/c1?session=s1')).toBeNull();

    writePaywallContinuation({
      triggerSource: 'chat_voice',
      requiredCredits: 9,
      returnTo: `/chat/${characterId}?session=${conversationSessionId}`,
      replayContextId: '11111111-1111-4111-8111-111111111111',
      now: 10,
    });
    expect(readPaywallContinuation(10)).toMatchObject({
      triggerSource: 'chat_voice',
      requiredCredits: 9,
      characterId,
      conversationSessionId,
      replayContextId: '11111111-1111-4111-8111-111111111111',
    });
    expect(readPaywallContinuation(10 + PAYWALL_CONTINUATION_TTL_MS + 1)).toBeNull();
  });
});
