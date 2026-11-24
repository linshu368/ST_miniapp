import { describe, expect, it } from 'vitest';

import {
  autoLight,
  changeScope,
  currentScope,
  effectiveBackground,
  EMPTY_PREFS,
  forgetImage,
  parseBackgroundPrefs,
  plateOpacity,
  resolvedLight,
  selectImage,
  setLight,
  UNKNOWN_TONE,
  veilOpacity,
  type BackgroundPrefs,
} from './chat-background';

const A = 'character-a';
const B = 'character-b';
const plain = (img: string) => ({ img, night: null, day: null });

describe('背景生效范围', () => {
  it('这张卡自己的优先，其余跟随全部对话', () => {
    const prefs = selectImage(selectImage(EMPTY_PREFS, A, 'character', 'img-1'), B, 'all', 'img-2');
    expect(effectiveBackground(prefs, A)?.img).toBe('img-1');
    expect(effectiveBackground(prefs, B)?.img).toBe('img-2');
    expect(currentScope(prefs, A)).toBe('character');
    expect(currentScope(prefs, B)).toBe('all');
    expect(currentScope(EMPTY_PREFS, A)).toBe('character');
  });

  it('全局有图时这张卡可以单独不用；全局没图时「无」不占记录', () => {
    const withGlobal = selectImage(EMPTY_PREFS, B, 'all', 'img-2');
    const off = selectImage(withGlobal, A, 'character', 'none');
    expect(effectiveBackground(off, A)).toBeNull();
    expect(effectiveBackground(off, B)?.img).toBe('img-2');
    expect(selectImage(EMPTY_PREFS, A, 'character', 'none').chars).toEqual({});
  });

  it('先改成全部对话又改回仅此角色，还原原来的全局图', () => {
    const start: BackgroundPrefs = { global: plain('img-2'), chars: { [A]: plain('img-1') } };
    const all = changeScope(start, A, 'all');
    expect(all).toEqual({ global: plain('img-1'), chars: {} });
    expect(changeScope(all, A, 'character', start.global)).toEqual(start);
  });

  it('这张卡没有图时改成全部对话，不会清掉别人的全局图', () => {
    const start: BackgroundPrefs = { global: plain('img-2'), chars: { [A]: plain('none') } };
    expect(changeScope(start, A, 'all')).toEqual({ global: plain('img-2'), chars: {} });
  });

  it('删图后用到它的地方都回到没设过', () => {
    const prefs: BackgroundPrefs = {
      global: plain('img-1'),
      chars: { [A]: plain('img-1'), [B]: plain('img-2') },
    };
    expect(forgetImage(prefs, 'img-1')).toEqual({ global: null, chars: { [B]: plain('img-2') } });
  });

  it('采光写在当前生效的那条上，夜间白天互不影响', () => {
    const prefs = setLight(selectImage(EMPTY_PREFS, A, 'all', 'img-1'), A, 'night', 40);
    expect(prefs.global).toEqual({ img: 'img-1', night: 40, day: null });
    expect(setLight(EMPTY_PREFS, A, 'night', 40)).toBe(EMPTY_PREFS);
  });

  it('最多记 200 张卡，删最久没动过的', () => {
    let prefs = EMPTY_PREFS;
    for (let index = 0; index < 205; index += 1) {
      prefs = selectImage(prefs, `c-${index}`, 'character', 'cover');
    }
    expect(Object.keys(prefs.chars)).toHaveLength(200);
    expect(prefs.chars['c-4']).toBeUndefined();
    expect(prefs.chars['c-204']).toBeDefined();
  });

  it('存储内容不合法时按没设过处理', () => {
    expect(parseBackgroundPrefs(null)).toEqual(EMPTY_PREFS);
    expect(parseBackgroundPrefs('{oops')).toEqual(EMPTY_PREFS);
    expect(
      parseBackgroundPrefs(
        JSON.stringify({
          global: { img: 'none' },
          chars: { [A]: { img: 'cover', night: 999, day: 30 }, [B]: { img: 1 } },
        })
      )
    ).toEqual({ global: null, chars: { [A]: { img: 'cover', night: null, day: 30 } } });
  });
});

describe('采光', () => {
  const tones = [{ hi: 1, lo: 0.9 }, { hi: 0.1, lo: 0 }, UNKNOWN_TONE];

  it('采光越高遮罩越透', () => {
    expect(veilOpacity(0)).toBe(0.96);
    expect(veilOpacity(100)).toBe(0.1);
  });

  it('任何图片、任何采光都读得清：字底补到够为止，且不封死成纯色', () => {
    for (const appearance of ['night', 'day'] as const) {
      for (const tone of tones) {
        for (let light = 0; light <= 100; light += 5) {
          expect(plateOpacity(light, appearance, tone)).toBeLessThan(0.94);
        }
      }
    }
  });

  it('图片不碍事时不垫字底', () => {
    expect(plateOpacity(100, 'night', { hi: 0.1, lo: 0 })).toBe(0);
    expect(plateOpacity(100, 'day', { hi: 1, lo: 0.97 })).toBe(0);
  });

  it('自动采光随图片亮度走，手动值优先', () => {
    expect(autoLight('night', { hi: 0.2, lo: 0 })).toBe(70);
    expect(autoLight('night', { hi: 1, lo: 0.9 })).toBeLessThan(70);
    expect(resolvedLight({ img: 'cover', night: 12, day: null }, 'night', UNKNOWN_TONE)).toBe(12);
  });
});
