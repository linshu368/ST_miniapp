import { describe, expect, it } from 'vitest';
import { freeZoneThinkingHint } from './free-zone';

describe('freeZoneThinkingHint', () => {
  const model = (thinking: 'switchable' | 'always' | 'hidden') => ({
    display_name: 'GLM 5.3',
    thinking,
  });

  it('只在开关对当前模型不起作用的那个方向提示', () => {
    expect(freeZoneThinkingHint(model('always'), false)).toBe(
      'GLM 5.3 不支持关闭深度思考，思考过程会照常显示'
    );
    expect(freeZoneThinkingHint(model('always'), true)).toBeNull();
    expect(freeZoneThinkingHint(model('hidden'), true)).toBe('GLM 5.3 不支持显示思考过程');
    expect(freeZoneThinkingHint(model('hidden'), false)).toBeNull();
  });

  it('开关正常起作用、或用的不是免费模型时不打扰', () => {
    expect(freeZoneThinkingHint(model('switchable'), false)).toBeNull();
    expect(freeZoneThinkingHint(model('switchable'), true)).toBeNull();
    expect(freeZoneThinkingHint(null, false)).toBeNull();
  });
});
