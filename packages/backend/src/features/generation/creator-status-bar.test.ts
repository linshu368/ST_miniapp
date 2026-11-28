import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyCharacterDraft } from '@miniapp/shared';

vi.mock('./upstream.js', () => ({
  resolveProviderUpstream: () => ({ url: 'http://upstream.test', apiKey: 'test-key', headers: {} }),
  forwardToUpstream: vi.fn(),
}));

import { forwardToUpstream } from './upstream.js';
import { config } from '../../platform/config.js';
import {
  MAX_ATTEMPTS,
  STATUS_BAR_AI_FALLBACK_MODEL,
  STATUS_BAR_AI_MODEL,
  generateCreatorStatusBar,
  routeForAttempt,
} from './creator-status-bar.js';
import {
  buildDescribePrompt,
  buildEditPrompt,
  buildGeneratePrompt,
} from './creator-status-bar-prompts.js';

const forward = vi.mocked(forwardToUpstream);

const VALID = {
  version: 1,
  note: '追踪主角这一路的体力和所在位置。',
  sections: [
    {
      id: 's-1',
      title: '局势',
      repeat: null,
      items: [
        {
          id: 'i-1',
          name: '体力',
          style: 'percent',
          desc: '主角当前的体力。赶路、战斗会让它掉，每轮最多掉10；休息、吃东西会恢复，每轮最多涨15。',
          init: '80%',
        },
        {
          id: 'i-2',
          name: '所在',
          style: 'line',
          desc: '主角此刻所在的具体地点，换了地方就如实改写，写到街道或房间一级。',
          init: '城门口',
        },
      ],
    },
  ],
};

const modelReply = (content: string, finish = 'stop') =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const upstreamError = (status: number) => new Response('busy', { status });

const draft = { ...emptyCharacterDraft(), name: '测试角色', description: '一个普通的旅人。' };

const originalDraftApiKey = config.voice.draft.apiKey;
beforeEach(() => {
  forward.mockReset();
  // Only the OpenRouter transport is mocked here; local .env must not select a real provider.
  Object.assign(config.voice.draft, { apiKey: '' });
});
afterEach(() => Object.assign(config.voice.draft, { apiKey: originalDraftApiKey }));

describe('generateCreatorStatusBar 重试', () => {
  it('上游报错、输出不完整都会重来，第 3 次成功就返回', async () => {
    forward
      .mockResolvedValueOnce(upstreamError(502))
      .mockResolvedValueOnce(modelReply('{"version":1', 'length'))
      .mockResolvedValueOnce(modelReply(JSON.stringify(VALID)));
    const { template } = await generateCreatorStatusBar(draft);
    expect(template.sections[0]!.items.map((item) => item.name)).toEqual(['体力', '所在']);
    expect(forward).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('3 次都失败才报错，报最后一次的原因', async () => {
    forward.mockImplementation(async () => upstreamError(503));
    await expect(generateCreatorStatusBar(draft)).rejects.toMatchObject({ code: 'unavailable' });
    expect(forward).toHaveBeenCalledTimes(3);
  });

  it('不合格时带着问题清单重来', async () => {
    const bad = structuredClone(VALID);
    bad.sections[0]!.items[0]!.desc = '体力';
    forward
      .mockResolvedValueOnce(modelReply(JSON.stringify(bad)))
      .mockResolvedValueOnce(modelReply(JSON.stringify(VALID)));
    await generateCreatorStatusBar(draft);
    expect(forward).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String(forward.mock.calls[1]![0].body)) as {
      messages: Array<{ content: string }>;
    };
    expect(retryBody.messages.at(-1)!.content).toContain('体力');
  });

  it('作者已断开就不再重试', async () => {
    const abort = new AbortController();
    abort.abort();
    forward.mockImplementation(async () => upstreamError(502));
    await expect(generateCreatorStatusBar(draft, abort.signal)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(forward).toHaveBeenCalledTimes(1);
  });
});

describe('generateCreatorStatusBar 取舍说明', () => {
  it('模型给了 remark 就原样带回，没给是空串', async () => {
    forward
      .mockResolvedValueOnce(
        modelReply(JSON.stringify({ ...VALID, remark: '要的项太多，合并了两项' }))
      )
      .mockResolvedValueOnce(modelReply(JSON.stringify(VALID)));
    expect((await generateCreatorStatusBar(draft)).remark).toBe('要的项太多，合并了两项');
    expect((await generateCreatorStatusBar(draft)).remark).toBe('');
  });
});

describe('routeForAttempt 模型路由', () => {
  const saved = config.voice.draft.apiKey;
  // 配置在类型上只读，测试里临时改一下密钥
  const setKey = (apiKey: string) => Object.assign(config.voice.draft, { apiKey });
  afterEach(() => setKey(saved));

  it('配了 DeepSeek：前两次 v4 pro，最后一次走兜底', () => {
    setKey('test-deepseek-key');
    expect(routeForAttempt(0)).toEqual({ channel: 'deepseek', model: STATUS_BAR_AI_MODEL });
    expect(routeForAttempt(1)).toEqual({ channel: 'deepseek', model: STATUS_BAR_AI_MODEL });
    expect(routeForAttempt(MAX_ATTEMPTS - 1)).toEqual({
      channel: 'openrouter',
      model: STATUS_BAR_AI_FALLBACK_MODEL,
    });
  });

  it('没配 DeepSeek 全走兜底；运营指定模型全程按指定的走', () => {
    setKey('');
    expect(routeForAttempt(0).model).toBe(STATUS_BAR_AI_FALLBACK_MODEL);
    setKey('test-deepseek-key');
    expect(routeForAttempt(0, 'x/model')).toEqual({ channel: 'openrouter', model: 'x/model' });
  });
});

describe('方向写进提示词', () => {
  it('玩家的方向单独成块，并说明玩家说了算', () => {
    const prompt = buildGeneratePrompt(draft, {
      direction: '加一个她的羞耻度',
      audience: 'player',
    });
    expect(prompt).toContain('【玩家的方向】\n加一个她的羞耻度');
    expect(prompt).toContain('绝对决定权');
    expect(prompt.indexOf('【玩家的方向】')).toBeLessThan(prompt.indexOf('【角色资料】'));
  });

  it('不填方向就只按角色资料生成', () => {
    const prompt = buildGeneratePrompt(draft);
    expect(prompt).not.toContain('的方向】');
    expect(prompt).toContain('根据下面的角色资料');
  });

  it('玩家的主角人设、补充设定有就带上，没有就不出现', () => {
    const withSettings = buildEditPrompt(draft, VALID as never, '加一项', {
      audience: 'player',
      persona: '我叫林远，刚入职的助理',
      notes: '她其实早就认识我',
    });
    expect(withSettings).toContain('玩家的主角人设');
    expect(withSettings).toContain('我叫林远，刚入职的助理');
    expect(withSettings).toContain('她其实早就认识我');
    const without = buildEditPrompt(draft, VALID as never, '加一项', { audience: 'player' });
    expect(without).not.toContain('玩家的主角人设');
    expect(without).not.toContain('玩家的补充设定');
  });

  it('帮写说明带上整套状态栏作参考', () => {
    const item = VALID.sections[0]!.items[0]!;
    const prompt = buildDescribePrompt(draft, item as never, { template: VALID as never });
    expect(prompt).toContain('整套状态栏（只作参考');
    expect(prompt).toContain('所在');
  });

  it('帮写说明时已写的内容当草稿保留', () => {
    const item = { ...VALID.sections[0]!.items[0]!, desc: '每次她脸红就涨' };
    expect(buildDescribePrompt(draft, item as never)).toContain('【这一项的草稿】\n每次她脸红就涨');
  });
});
