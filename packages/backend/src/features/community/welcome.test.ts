import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCommunityWelcome, sendCommunityWelcome, welcomeDisplayName } from './welcome.js';
import { observation } from '../../platform/observability/runtime.js';
import { createObserver } from '../../platform/observability/core.js';
import type { ObservationEvent } from '../../platform/observability/events.js';

vi.mock('../../platform/config.js', () => ({
  config: { telegramCommunityBotToken: 'runtime-test-only' },
}));
vi.mock('../../lib/telegram-links.js', () => ({ buildMiniappDeepLink: async () => null }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('community welcome', () => {
  it.each([200, 503])(
    'observes transport %s and reports API failure without retrying the welcome',
    async (status) => {
      const records: ObservationEvent[] = [];
      const observer = createObserver([
        (event) => {
          records.push(event);
        },
      ]);
      vi.spyOn(observation, 'start').mockImplementation(observer.start);
      const execute = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: false, description: 'private-response' }), { status })
        );
      vi.stubGlobal('fetch', execute);
      const warn = vi.fn();
      const log = { warn, info: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
      await expect(
        sendCommunityWelcome(
          { chatId: '-100', telegramUserId: 42, firstName: 'private-name', rewardCredits: null },
          log
        )
      ).resolves.toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'community.welcome.failed', err: expect.any(Error) }),
        expect.any(String)
      );
      expect(records.at(-1)).toMatchObject({
        operation: 'community.welcome.telegram',
        upstream_status: status,
        outcome: status === 200 ? 'succeeded' : 'failed',
      });
      expect(JSON.stringify(records)).not.toContain('private');
      expect(JSON.stringify(records)).not.toContain('runtime-test-only');
      expect((execute.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  );
  it('escapes names and mentions the joiner by id', () => {
    const message = buildCommunityWelcome({
      chatId: '-100',
      telegramUserId: 42,
      firstName: '<b>小雨</b>',
      lastName: '&',
      rewardCredits: 500,
    });
    expect(message.text).toContain('<a href="tg://user?id=42">&lt;b&gt;小雨&lt;/b&gt; &amp;</a>');
    expect(message.text).toContain('500 星尘');
    expect(message.buttonText).toBe('回到秘境继续聊 ›');
  });

  it('welcomes people without an account without promising stardust', () => {
    const message = buildCommunityWelcome({
      chatId: '-100',
      telegramUserId: 7,
      rewardCredits: null,
    });
    expect(message.text).not.toContain('星尘');
    expect(message.text).toContain('新朋友');
    expect(message.buttonText).toBe('进入秘境 ›');
  });

  it('truncates long names by characters', () => {
    expect(welcomeDisplayName('一'.repeat(30))).toBe(`${'一'.repeat(24)}…`);
    expect(welcomeDisplayName('  ', '')).toBe('新朋友');
  });
});
