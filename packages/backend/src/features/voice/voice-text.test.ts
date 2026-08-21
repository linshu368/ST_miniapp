import { describe, expect, it } from 'vitest';
import {
  cleanTags,
  extractQuotedLines,
  fixPunctuation,
  normalizeConvertedText,
  normalizeCustomText,
  stripCodeFence,
  stripFillerWords,
  stripQuotes,
  stripTags,
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

describe('fixPunctuation', () => {
  it('replaces every ellipsis form so TTS does not read them flat', () => {
    expect(fixPunctuation('我……不知道')).toBe('我，不知道');
    expect(fixPunctuation('我...不知道')).toBe('我，不知道');
    expect(fixPunctuation('别走。。。')).toBe('别走！');
  });

  it('collapses the commas its own substitutions can pile up', () => {
    expect(fixPunctuation('我…………你')).toBe('我，你');
  });

  it('drops the drawn-out wave that TTS reads as a word', () => {
    expect(fixPunctuation('好呀～～')).toBe('好呀');
    expect(fixPunctuation('来嘛~')).toBe('来嘛');
  });

  it('drops leading punctuation left behind on each line', () => {
    // 标签被剥掉后常在句首留下一个逗号，念出来是个突兀的停顿
    expect(fixPunctuation('，我在')).toBe('我在');
    expect(fixPunctuation('第一句\n。第二句')).toBe('第一句\n第二句');
  });

  it('leaves written filler words to stripFillerWords', () => {
    // 自定义链路只调 fixPunctuation，用户敲的「嗯」必须留着
    expect(fixPunctuation('嗯，我在')).toBe('嗯，我在');
  });
});

describe('stripFillerWords', () => {
  it('removes written filler words that would be read literally', () => {
    expect(stripFillerWords('嗯，我在')).toBe('我在');
    expect(stripFillerWords('唔……好吧')).toBe('好吧');
    expect(stripFillerWords('唔 好吧')).toBe('好吧');
  });
});

describe('stripQuotes', () => {
  it('removes every quote form, straight and full-width alike', () => {
    expect(stripQuotes('“你回来了”')).toBe('你回来了');
    expect(stripQuotes('「别走」')).toBe('别走');
    expect(stripQuotes('"就这样"')).toBe('就这样');
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

describe('normalizeConvertedText', () => {
  it('leaves plain text only, because speech-02-hd reads tags out loud as English', () => {
    const raw = '```\n（声音颤抖）(sighs)“你会不会……也有一天，就这样走掉啊？”(voice breaking)\n```';
    expect(normalizeConvertedText(raw)).toBe('你会不会，也有一天，就这样走掉啊？');
  });

  it('collapses a tag-only line to empty so the caller falls through to the next gate', () => {
    // 空台词判定为无效、换下一闸重试，比让 TTS 念出 "groans" 好
    expect(normalizeConvertedText('(groans)')).toBe('');
  });

  it('collapses junk-only output to empty so the caller can fall through', () => {
    expect(normalizeConvertedText('（沉默）')).toBe('');
  });
});

describe('normalizeCustomText', () => {
  it('reads back exactly what the user typed', () => {
    expect(normalizeCustomText('今天我想你了，很想。')).toBe('今天我想你了，很想。');
  });

  it('keeps filler words the user typed on purpose', () => {
    // 与写稿产物的唯一区别：用户敲的「嗯」是他想说的话，不是模型用来替代呼吸的
    expect(normalizeCustomText('嗯，我在')).toBe('嗯，我在');
  });

  it('still blocks markup that would be read literally', () => {
    expect(normalizeCustomText('(sighs)别走')).toBe('别走');
    expect(normalizeCustomText('（小声）“我等你”')).toBe('我等你');
    expect(normalizeCustomText('好呀～')).toBe('好呀');
  });

  it('collapses markup-only input to empty so the route can reject it', () => {
    expect(normalizeCustomText('（）')).toBe('');
  });
});

describe('extractQuotedLines', () => {
  it('pulls out dialogue only, one line each', () => {
    const source = '她低头看着你，“你回来了。”\n屋里很暗。她又说：“我等了很久。”';
    expect(extractQuotedLines(source)).toBe('你回来了。\n我等了很久。');
  });

  it('handles the other quote styles', () => {
    expect(extractQuotedLines('她说「别走」，然后『我等你』')).toBe('别走\n我等你');
  });

  it('returns empty when the source has no dialogue at all', () => {
    expect(extractQuotedLines('她站起身，赤着脚踩在木地板上。')).toBe('');
  });
});
