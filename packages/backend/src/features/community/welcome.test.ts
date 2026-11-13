import { describe, expect, it } from 'vitest';
import { buildCommunityWelcome, welcomeDisplayName } from './welcome.js';

describe('community welcome', () => {
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
