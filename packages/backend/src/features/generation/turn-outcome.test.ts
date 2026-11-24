import { describe, expect, it, vi } from 'vitest';

vi.mock('./chat-recovery-config.js', () => ({ readChatRecoveryConfig: vi.fn() }));

import { classifyTurn, createTurnFacts, refusalHit, type TurnFacts } from './turn-outcome.js';
import type { GenerationResult } from './types.js';

const ok: GenerationResult = {
  status: 'success',
  content: '她笑了笑。',
  generationId: 'g',
  finishReason: 'stop',
  chargeId: null,
  modelId: null,
  modelOpenRouterId: 'm',
};

function facts(patch: Partial<TurnFacts>): TurnFacts {
  return { ...createTurnFacts(), ...patch };
}

function classify(
  patch: Partial<TurnFacts>,
  extra: Partial<Parameters<typeof classifyTurn>[0]> = {}
) {
  return classifyTurn({
    facts: facts(patch),
    result: ok,
    timedOut: false,
    cancelled: false,
    finalRefused: false,
    ...extra,
  });
}

describe('聊天成功率口径（用户最终结果 / 首发自己的结果）', () => {
  it('首发正常写完：两边都成功', () => {
    expect(classify({ deliveredRole: 'primary', deliveredEnd: 'completed' })).toEqual({
      outcome: 'success',
      primaryOutcome: 'success',
      rescue: 'none',
    });
  });

  it('首发慢、首字兜底交付：用户成功，首发记超时', () => {
    expect(
      classify({
        deliveredRole: 'fallback',
        deliveredEnd: 'completed',
        primaryCallEnds: ['cancelled'],
      })
    ).toEqual({ outcome: 'success', primaryOutcome: 'timeout', rescue: 'fallback' });
  });

  it('首发出字前报错、兜底交付：首发记报错', () => {
    expect(
      classify({
        deliveredRole: 'fallback',
        deliveredEnd: 'completed',
        primaryCallEnds: ['upstream_error'],
      })?.primaryOutcome
    ).toBe('error');
  });

  it('首发出字后卡住、重写成功：用户成功，首发记中断', () => {
    expect(
      classify({ deliveredRole: 'primary', deliveredEnd: 'stalled', recovered: true })
    ).toEqual({ outcome: 'success', primaryOutcome: 'interrupted', rescue: 'rewrite' });
  });

  it('首发拒答、重写成功：首发记拒答', () => {
    expect(
      classify({ deliveredRole: 'primary', deliveredEnd: 'refused', recovered: true })
        ?.primaryOutcome
    ).toBe('refused');
  });

  it('首发写完但开头命中词池（开关关或未成年人放行）：两边都记拒答', () => {
    expect(
      classify({ deliveredRole: 'primary', deliveredEnd: 'completed' }, { finalRefused: true })
    ).toEqual({ outcome: 'refused', primaryOutcome: 'refused', rescue: 'none' });
  });

  it('中断没救回：两边都记中断；供应商内容过滤记拒答', () => {
    expect(classify({ deliveredRole: 'primary', deliveredEnd: 'stream_error' })?.outcome).toBe(
      'interrupted'
    );
    expect(classify({ deliveredRole: 'primary', deliveredEnd: 'content_filter' })?.outcome).toBe(
      'refused'
    );
  });

  it('谁都没出字：截止记超时，报错记报错', () => {
    expect(
      classify({ primaryCallEnds: ['first_token_deadline'] }, { result: null, timedOut: true })
    ).toEqual({
      outcome: 'timeout',
      primaryOutcome: 'timeout',
      rescue: 'none',
    });
    expect(
      classify(
        { primaryCallEnds: ['upstream_error'] },
        { result: { ...ok, status: 'upstream_error' } }
      )?.outcome
    ).toBe('error');
  });

  it('余额不足、用户停止不计', () => {
    expect(classify({}, { result: { ...ok, status: 'insufficient_balance' } })).toBeNull();
    expect(classify({ deliveredRole: 'primary', deliveredEnd: 'cancelled' })).toBeNull();
    expect(
      classify({ deliveredRole: 'primary', deliveredEnd: 'completed' }, { cancelled: true })
    ).toBeNull();
  });
});

describe('refusalHit', () => {
  const rule = { checkChars: 10, keywords: ['写不了'] };
  it('只看开头 checkChars 个字，大小写不敏感', () => {
    expect(refusalHit('  这段我写不了。', rule)).toBe(true);
    expect(refusalHit('她慢慢走过来，低声说：我写不了', rule)).toBe(false);
    expect(refusalHit('I CANNOT do it', { checkChars: 30, keywords: ['i cannot'] })).toBe(true);
    expect(refusalHit('任何内容', null)).toBe(false);
  });
});
