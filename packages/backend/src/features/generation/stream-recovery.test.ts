import { describe, expect, it, vi } from 'vitest';

vi.mock('./call-ledger.js', () => ({ insertLlmCall: vi.fn(), recordStreamEnd: vi.fn() }));

const { involvesMinor, planRecovery, recentDialogue, runRecovery, toRecoveryRules } =
  await import('./stream-recovery.js');
const { insertLlmCall } = await import('./call-ledger.js');
const { createRefusalDetector } = await import('./stream-pass.js');
type Pass = Parameters<typeof planRecovery>[0]['pass'];

const pass = (end: Pass['end'], content = '半段正文'): Pass => ({
  end,
  error: null,
  maxGapMs: 0,
  tailGapMs: 0,
  refusalHit: end === 'refused',
  result: {
    completed: false,
    content,
    deltaCount: 1,
    generationId: null,
    finishReason: null,
    usage: null,
    responseMetadata: {},
  },
});

const rules = toRecoveryRules({
  fallback_first_token_ms: 3000,
  interruption: { enabled: true, stall_ms: 3000 },
  refusal: { enabled: true, check_chars: 30, keywords: ['我不能写'] },
});

describe('未成年人判断', () => {
  it.each([
    ['她才12岁', true],
    ['十七岁的少女', true],
    ['初中生', true],
    ['二十岁的她', false],
    ['27岁的上班族', false],
    ['18岁生日', false],
    ['孩子他爸', false],
  ])('%s → %s', (text, expected) => {
    expect(involvesMinor([text])).toBe(expected);
  });
});

describe('拒答检测（只判定，不压输出）', () => {
  it('前 N 个字里命中即判，不区分大小写', () => {
    const detector = createRefusalDetector({ checkChars: 30, keywords: ['I CANNOT'] });
    expect(detector.push('I cannot')).toBe('refused');
  });
  it('看满 N 个字没命中就不再检查', () => {
    const detector = createRefusalDetector({ checkChars: 5, keywords: ['我不能写'] });
    expect(detector.push('她推开门，')).toBe('clear');
    expect(detector.push('我不能写')).toBe('clear');
  });
  it('流在看满之前结束：按已看到的判', () => {
    const detector = createRefusalDetector({ checkChars: 30, keywords: ['我不能写'] });
    expect(detector.push('好的。')).toBe('checking');
    expect(detector.settle()).toBe('clear');
  });
});

describe('是否启用兜底', () => {
  const plan = (p: Pass, overrides: Partial<Parameters<typeof planRecovery>[0]> = {}) =>
    planRecovery({ pass: p, rules, dialogue: [], elapsedMs: 5_000, available: true, ...overrides });
  it('中断、拒答都擦掉重写', () => {
    expect(plan(pass('stalled'))).toEqual({ mode: 'rewrite', trigger: 'stalled' });
    expect(plan(pass('disconnected', ''))).toEqual({ mode: 'rewrite', trigger: 'disconnected' });
    expect(plan(pass('refused'))).toEqual({ mode: 'rewrite', trigger: 'refused' });
  });
  it('技术故障不做未成年人判断，交给供应商', () => {
    expect(plan(pass('stalled', '她是小学生'), { dialogue: ['她是小学生'] })).toEqual({
      mode: 'rewrite',
      trigger: 'stalled',
    });
  });
  it('正常结束、用户停止、5400 字上限不兜底', () => {
    expect(plan(pass('completed'))).toBeNull();
    expect(plan(pass('cancelled'))).toBeNull();
    expect(plan(pass('output_cap'))).toBeNull();
  });
  it('关闭、涉及未成年人、时间不够时不兜底', () => {
    expect(
      planRecovery({
        pass: pass('stalled'),
        rules: toRecoveryRules(null),
        dialogue: [],
        elapsedMs: 0,
        available: true,
      })
    ).toEqual({ skip: 'disabled', trigger: 'stalled' });
    expect(plan(pass('content_filter'), { dialogue: ['她是小学生'] })).toEqual({
      skip: 'minor_guard',
      trigger: 'content_filter',
    });
    expect(plan(pass('stalled'), { elapsedMs: 95_000 })).toEqual({
      skip: 'deadline',
      trigger: 'stalled',
    });
  });
});

describe('未成年人判断的上下文', () => {
  it('不看包着平台规则的最后一条 user 消息，只看上一条回复与用户原话', () => {
    const dialogue = recentDialogue({
      messages: [
        { role: 'system', content: '角色卡' },
        { role: 'assistant', content: '上一条回复' },
        { role: 'user', content: '平台规则：禁止涉及未成年人。\n用户：继续' },
      ],
      userInput: '继续',
    });
    expect(dialogue).toEqual(['上一条回复', '继续']);
    expect(involvesMinor(dialogue)).toBe(false);
  });
});

describe('重写台账的 Surplus 请求号', () => {
  const sse = (headers: Record<string, string>) =>
    new Response(
      'data: {"choices":[{"delta":{"content":"雨下得很大。"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } }
    );
  const run = async (headers: Record<string, string>) => {
    vi.mocked(insertLlmCall).mockClear().mockResolvedValue(undefined);
    const outcome = await runRecovery({
      trigger: 'stalled',
      request: { messages: [{ role: 'user', content: '你好' }] } as never,
      rules,
      forward: {
        model: { provider: 'surplus', providerModelId: 'deepseek-v4.1-flash-1017' },
        send: async () => sse(headers),
      },
      signal: new AbortController().signal,
      outputCap: new AbortController().signal,
      onContent: () => undefined,
      onReset: () => undefined,
      ledger: {
        chatHistoryId: 'c0000000-0000-4000-8000-000000000001',
        lane: 'free_zone',
        candidateId: 'free-x',
      },
      log: { sys: { warn: vi.fn() }, biz: {} } as never,
    });
    expect(outcome.callEnd).toBe('completed');
    return vi.mocked(insertLlmCall).mock.calls[0]?.[0];
  };
  it.each([
    ['x-si-request-id', { 'x-si-request-id': 'si-1' }, 'si-1'],
    ['只有 x-request-id（与首字兜底同读法）', { 'x-request-id': 'req-1' }, 'req-1'],
    [
      '两个都有时取 x-si-request-id',
      { 'x-si-request-id': 'si-2', 'x-request-id': 'req-2' },
      'si-2',
    ],
  ])('%s', async (_name, headers, expected) => {
    expect(await run(headers)).toMatchObject({
      role: 'rewrite',
      requestId: expected,
      lane: 'free_zone',
    });
  });
});
