import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyCharacterDraft } from '@miniapp/shared';

vi.mock('./upstream.js', () => ({
  resolveProviderUpstream: () => ({ url: 'http://upstream.test', apiKey: 'test-key', headers: {} }),
  forwardToUpstream: vi.fn(),
}));

import { forwardToUpstream } from './upstream.js';
import { MAX_ATTEMPTS, generateCreatorStatusBar } from './creator-status-bar.js';

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

beforeEach(() => forward.mockReset());

describe('generateCreatorStatusBar 重试', () => {
  it('上游报错、输出不完整都会重来，第 3 次成功就返回', async () => {
    forward
      .mockResolvedValueOnce(upstreamError(502))
      .mockResolvedValueOnce(modelReply('{"version":1', 'length'))
      .mockResolvedValueOnce(modelReply(JSON.stringify(VALID)));
    const template = await generateCreatorStatusBar(draft);
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
