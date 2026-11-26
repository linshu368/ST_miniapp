import { describe, expect, it, vi } from 'vitest';

vi.mock('./chat-recovery-config.js', () => ({ readChatRecoveryConfig: vi.fn() }));

import {
  classifyFallbacks,
  classifyTurn,
  createTurnFacts,
  refusalHit,
  type FallbackCallFact,
  type RewriteFact,
  type TurnFacts,
} from './turn-outcome.js';
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

describe('兜底模型口径（只记真正决定用户结果的兜底调用）', () => {
  const fb = (patch: Partial<FallbackCallFact> = {}): FallbackCallFact => ({
    provider: 'surplus',
    model: 'deepseek-v4.1-flash-1017',
    endReason: 'first_token_observed',
    httpStatus: 200,
    preTokenOutcome: null,
    ...patch,
  });
  const rw = (patch: Partial<RewriteFact> = {}): RewriteFact => ({
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4.1-flash-1017',
    trigger: 'stalled',
    callEnd: 'completed',
    passEnd: 'completed',
    httpStatus: 200,
    recovered: true,
    ...patch,
  });
  const run = (
    patch: Partial<TurnFacts>,
    extra: Partial<Parameters<typeof classifyFallbacks>[0]> = {}
  ) =>
    classifyFallbacks({
      facts: facts(patch),
      result: ok,
      timedOut: false,
      cancelled: false,
      finalRefused: false,
      ...extra,
    }).map(({ kind, trigger, outcome, reason }) => ({ kind, trigger, outcome, reason }));

  it('兜底发出后首发先出字（没用上）、没发出兜底：都不记', () => {
    expect(
      run({
        deliveredRole: 'primary',
        deliveredEnd: 'completed',
        fallbackCall: fb({ endReason: 'cancelled' }),
      })
    ).toEqual([]);
    expect(run({ deliveredRole: 'primary', deliveredEnd: 'completed' })).toEqual([]);
  });

  it('首发超时、兜底写完：成功；首发报错时启动原因记报错', () => {
    expect(
      run({
        deliveredRole: 'fallback',
        deliveredEnd: 'completed',
        primaryCallEnds: ['cancelled'],
        fallbackCall: fb(),
      })
    ).toEqual([
      { kind: 'first_token', trigger: 'primary_timeout', outcome: 'success', reason: 'none' },
    ]);
    expect(
      run({
        deliveredRole: 'fallback',
        deliveredEnd: 'completed',
        primaryCallEnds: ['upstream_error'],
        fallbackCall: fb(),
      })[0]?.trigger
    ).toBe('primary_error');
  });

  it('谁都没交付：兜底超时 / 报错带状态码 / 网络错误 / 出字前内容过滤', () => {
    const lost = (call: Partial<FallbackCallFact>) =>
      run({ primaryCallEnds: ['first_token_deadline'], fallbackCall: fb(call) })[0];
    expect(lost({ endReason: 'first_token_deadline', httpStatus: null })).toMatchObject({
      outcome: 'timeout',
      reason: 'first_token_deadline',
    });
    expect(lost({ endReason: 'upstream_error', httpStatus: 429 })).toMatchObject({
      outcome: 'error',
      reason: 'http_429',
    });
    expect(lost({ endReason: 'upstream_error', httpStatus: 503 })?.reason).toBe('http_5xx');
    expect(lost({ endReason: 'upstream_error', httpStatus: null })?.reason).toBe('network');
    expect(
      lost({ endReason: 'upstream_error', httpStatus: 200, preTokenOutcome: 'filtered' })?.reason
    ).toBe('content_filter');
  });

  it('兜底出字后卡住或拒答：兜底记中断 / 拒答，重写另记一条', () => {
    expect(
      run({
        deliveredRole: 'fallback',
        deliveredEnd: 'stalled',
        fallbackCall: fb(),
        recovered: true,
        rewrite: rw(),
      })
    ).toEqual([
      {
        kind: 'first_token',
        trigger: 'primary_timeout',
        outcome: 'interrupted',
        reason: 'stalled',
      },
      { kind: 'rewrite', trigger: 'interrupted', outcome: 'success', reason: 'none' },
    ]);
    expect(
      run(
        { deliveredRole: 'fallback', deliveredEnd: 'completed', fallbackCall: fb() },
        { finalRefused: true }
      )[0]
    ).toMatchObject({ outcome: 'refused', reason: 'refusal_words' });
  });

  it('出字后重写：超时 / 报错 / 中断 / 内容过滤 / 正文命中词池；首发交付的轮次也记', () => {
    const rewrite = (patch: Partial<RewriteFact>, finalRefused = false) =>
      run(
        { deliveredRole: 'primary', deliveredEnd: 'refused', rewrite: rw(patch) },
        { finalRefused }
      )[0];
    expect(
      rewrite({ callEnd: 'first_token_deadline', passEnd: 'stalled', recovered: false })
    ).toMatchObject({ kind: 'rewrite', outcome: 'timeout', reason: 'first_token_deadline' });
    expect(
      rewrite({ callEnd: 'upstream_error', passEnd: null, httpStatus: 404, recovered: false })
    ).toMatchObject({ outcome: 'error', reason: 'http_404' });
    expect(
      rewrite({ callEnd: 'stream_interrupted', passEnd: 'stream_error', recovered: false })
    ).toMatchObject({ outcome: 'interrupted', reason: 'stream_error' });
    expect(
      rewrite({ callEnd: 'stream_interrupted', passEnd: 'content_filter', recovered: false })
    ).toMatchObject({ outcome: 'refused', reason: 'content_filter' });
    expect(rewrite({ trigger: 'refused' }, true)).toMatchObject({
      trigger: 'refused',
      outcome: 'refused',
      reason: 'refusal_words',
    });
  });

  it('用户停止、重写被取消、余额不足：不记', () => {
    expect(
      run(
        { deliveredRole: 'fallback', deliveredEnd: 'completed', fallbackCall: fb() },
        { cancelled: true }
      )
    ).toEqual([]);
    expect(
      run({
        deliveredRole: 'primary',
        deliveredEnd: 'stalled',
        rewrite: rw({ callEnd: 'cancelled', recovered: false }),
      })
    ).toEqual([]);
    expect(
      run({ fallbackCall: fb() }, { result: { ...ok, status: 'insufficient_balance' } })
    ).toEqual([]);
  });
});
