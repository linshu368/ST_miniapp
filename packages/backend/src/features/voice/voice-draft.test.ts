import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../platform/config.js', () => ({
  config: {
    voice: {
      apiKey: 'tts-key',
      ttsUrl: 'https://tts.example/t2a',
      timeoutMs: 5000,
      draft: {
        apiKey: 'draft-key',
        url: 'https://draft.example/chat/completions',
        model: 'deepseek-v4-flash',
      },
    },
  },
}));

const { draftSpokenText } = await import('./voice-draft.js');
const { MAX_SPOKEN_VOICE_CHARS } = await import('@miniapp/shared');
const { VoiceUpstreamError } = await import('./voice-upstream.js');

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 依次返回给定的响应，用来验证逐闸降级 */
function stubUpstream(...responses: Response[]) {
  let call = 0;
  const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) => {
    const response = responses[call] ?? responses[responses.length - 1];
    call += 1;
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestBodyOf(fetchMock: ReturnType<typeof stubUpstream>, index: number) {
  return JSON.parse(fetchMock.mock.calls[index]?.[1]?.body ?? '{}');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('draftSpokenText — 闸 1 正常写稿', () => {
  it('返回清洗后的纯文本台词，标签一个不留', async () => {
    // 现行 TTS 模型 speech-02-hd 听不懂标签，会把 sighs 当英文单词念出来
    stubUpstream(completion('（声音颤抖）(sighs)“我等了很久。”'));

    const result = await draftSpokenText('她低声说：我等了很久。');

    expect(result).toEqual({ text: '我等了很久。', gate: 'thinking_off' });
  });

  it('提示词拆成 system 与 user，且原文在 user 的末尾', async () => {
    const fetchMock = stubUpstream(completion('好的'));

    await draftSpokenText('原文正文');

    const body = requestBodyOf(fetchMock, 0);
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('原文正文');
    // 变量之后只剩闭合标签，前缀固定才吃得到上游的前缀缓存
    expect(body.messages[1].content.trimEnd().endsWith('</原文>')).toBe(true);
  });

  it('第一闸关掉思考。实测同等产出下它比开思考快十倍，而语音是用户点完要等的功能', async () => {
    const fetchMock = stubUpstream(completion('好的'));

    await draftSpokenText('原文');

    const body = requestBodyOf(fetchMock, 0);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe('draftSpokenText — 闸 2 开思考重试', () => {
  it('第一闸返回空正文时，让它想一会儿再来一次', async () => {
    const fetchMock = stubUpstream(completion(''), completion('(breath)我在。'));

    const result = await draftSpokenText('原文');

    expect(result).toEqual({ text: '我在。', gate: 'thinking_low' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = requestBodyOf(fetchMock, 1);
    expect(retry.reasoning_effort).toBe('low');
    expect(retry.thinking).toBeUndefined();
  });

  it('第一闸只回了个标签、清洗后剩空串时也重试', async () => {
    // 去标签之后这种回答什么都不剩，宁可重来一次也别让 TTS 念出 "groans"
    const fetchMock = stubUpstream(completion('(groans)'), completion('我在。'));

    const result = await draftSpokenText('原文');

    expect(result).toEqual({ text: '我在。', gate: 'thinking_low' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('第一闸台词超过红线时同样重试', async () => {
    const tooLong = '啊'.repeat(MAX_SPOKEN_VOICE_CHARS + 1);
    const fetchMock = stubUpstream(completion(tooLong), completion('短台词'));

    const result = await draftSpokenText('原文');

    expect(result.gate).toBe('thinking_low');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('刚好等于红线的台词是合法的，不该重试', async () => {
    const atLimit = '啊'.repeat(MAX_SPOKEN_VOICE_CHARS);
    const fetchMock = stubUpstream(completion(atLimit));

    const result = await draftSpokenText('原文');

    expect(result.gate).toBe('thinking_off');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('draftSpokenText — 闸 3 规则抽引号', () => {
  it('两次写稿都不可用时，从原文里抽引号', async () => {
    stubUpstream(completion(''), completion(''));

    const result = await draftSpokenText('她看着你，“你回来了。”屋里很暗。');

    expect(result).toEqual({ text: '你回来了。', gate: 'quote_fallback' });
  });

  it('抽出的引号仍超过 300 字时抛 voice_text_too_long，不送 TTS', async () => {
    // 长对白：引号内超过 300 字，闸 3 不放行，与「无可朗读内容」区分
    const longQuote = '啊'.repeat(MAX_SPOKEN_VOICE_CHARS + 1);
    stubUpstream(completion(''), completion(''));

    await expect(draftSpokenText(`她低声道：“${longQuote}”`)).rejects.toMatchObject({
      stage: 'draft',
      code: 'voice_text_too_long',
    });
  });
});

describe('draftSpokenText — 闸 4 拒绝放行', () => {
  it('原文里连引号都没有时抛错，不把空台词送去合成', async () => {
    stubUpstream(completion(''), completion(''));

    await expect(draftSpokenText('她站起身，赤着脚踩在木地板上。')).rejects.toMatchObject({
      stage: 'draft',
      code: 'voice_draft_unusable',
    });
  });
});

describe('draftSpokenText — 上游故障不静默降级', () => {
  it('HTTP 错误直接抛出，不继续走后面的闸', async () => {
    const fetchMock = stubUpstream(
      new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      })
    );

    const error = await draftSpokenText('她说：“你回来了。”').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoiceUpstreamError);
    expect(error).toMatchObject({ stage: 'draft', code: 'voice_draft_402' });
    // 原文里有引号，闸 3 本来能兜住——故意不兜，否则 key 配错会永远静默走兜底
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('超时归一成 timeout 错误码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      })
    );

    await expect(draftSpokenText('原文')).rejects.toMatchObject({
      stage: 'draft',
      code: 'voice_draft_timeout',
    });
  });
});
