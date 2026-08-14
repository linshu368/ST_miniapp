import { describe, expect, it } from 'vitest';

import { shouldExpandComposer } from './composer-layout';

/**
 * 用例与原版 st-extension/tests/message-presentation.test.ts 里的同名分组逐条对齐。
 * 新输入框不再引用 ST 的实现，这组断言是「行为没跑偏」的唯一凭证：
 * 阈值一旦被改动，输入框在临界长度上会开始来回跳，肉眼很难在改动当下发现。
 */
describe('shouldExpandComposer', () => {
  it('短消息保持单行，长内容与换行展开', () => {
    expect(shouldExpandComposer('你好', 48, false)).toBe(false);
    expect(shouldExpandComposer('第一行\n第二行', 48, false)).toBe(true);
    expect(shouldExpandComposer('很长的输入'.repeat(5), 48, false)).toBe(true);
    expect(shouldExpandComposer('视觉上已经换行', 56, false)).toBe(true);
  });

  it('展开态用更低的收起阈值，避免临界长度反复抖动', () => {
    // 15 字：未展开时不足以展开（>24），已展开时不足以收起（>12）
    const middle = '仍然有较多文字内容不能反复抖动';
    expect(shouldExpandComposer(middle, 48, false)).toBe(false);
    expect(shouldExpandComposer(middle, 48, true)).toBe(true);

    expect(shouldExpandComposer('已清空', 48, true)).toBe(false);
  });
});
