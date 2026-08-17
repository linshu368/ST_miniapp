import { describe, expect, it } from 'vitest';
import {
  cleanTags,
  fixEllipsis,
  normalizeConvertedText,
  stripCodeFence,
  stripTags,
  toSpokenText,
} from './voice-text.js';

describe('cleanTags', () => {
  it('keeps whitelisted tags and drops invented ones', () => {
    expect(cleanTags('(sighs)你回来了(voice breaking)')).toBe('(sighs)你回来了');
    expect(cleanTags('(breath)嗯？(gasps)')).toBe('(breath)嗯？(gasps)');
  });

  it('drops Chinese stage directions in either bracket style', () => {
    expect(cleanTags('（声音颤抖）我等了很久')).toBe('我等了很久');
    expect(cleanTags('(带着哭腔)别走')).toBe('别走');
  });

  it('normalizes multi-word tags before matching the whitelist', () => {
    expect(cleanTags('(lip smacking)真好吃')).toBe('(lip-smacking)真好吃');
    expect(cleanTags('(CLEAR THROAT)那个')).toBe('(clear-throat)那个');
  });
});

describe('fixEllipsis', () => {
  it('replaces every ellipsis form so TTS does not read them flat', () => {
    expect(fixEllipsis('我……不知道')).toBe('我，不知道');
    expect(fixEllipsis('我...不知道')).toBe('我，不知道');
    expect(fixEllipsis('别走。。。')).toBe('别走！');
  });

  it('removes written filler words that would be read literally', () => {
    expect(fixEllipsis('嗯，我在')).toBe('我在');
    expect(fixEllipsis('唔……好吧')).toBe('好吧');
  });

  it('collapses the commas its own substitutions can pile up', () => {
    expect(fixEllipsis('我…………你')).toBe('我，你');
  });
});

describe('stripTags', () => {
  it('removes tags and the double spaces they leave behind', () => {
    expect(stripTags('(sighs) 你 (breath) 回来了')).toBe('你 回来了');
    expect(stripTags('(inhale)我在')).toBe('我在');
  });

  it('leaves ordinary parentheses content alone', () => {
    // 走到这一步时中文括号已被 cleanTags 清掉，这里只验证标签正则不误伤
    expect(stripTags('三点(A)钟')).toBe('三点(A)钟');
  });
});

describe('stripCodeFence', () => {
  it('unwraps fenced output', () => {
    expect(stripCodeFence('```\n你好\n```')).toBe('你好');
    expect(stripCodeFence('```text\n你好\n```')).toBe('你好');
  });

  it('leaves unfenced output untouched', () => {
    expect(stripCodeFence('你好')).toBe('你好');
  });
});

describe('full pipeline', () => {
  it('turns raw LLM output into archived and spoken text', () => {
    const raw = '```\n（声音颤抖）(sighs)你会不会……也有一天，就这样走掉啊？(voice breaking)\n```';
    const converted = normalizeConvertedText(raw);
    expect(converted).toBe('(sighs)你会不会，也有一天，就这样走掉啊？');
    expect(toSpokenText(converted)).toBe('你会不会，也有一天，就这样走掉啊？');
  });

  it('can strip a reply down to nothing when the model returns only junk', () => {
    // 调用方要据此判失败，不能把空串送进 TTS
    expect(toSpokenText(normalizeConvertedText('（沉默）'))).toBe('');
  });
});
