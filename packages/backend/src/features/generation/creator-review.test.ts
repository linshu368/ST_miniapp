import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATOR_REVIEW_OUTPUT_JSON_SCHEMA,
  CREATOR_REVIEW_PROMPT_KEY,
  CREATOR_REVIEW_UNAVAILABLE_CODE,
  DEFAULT_CREATOR_REVIEW_PROMPT,
} from '@miniapp/shared';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  forward: vi.fn(),
  upstream: vi.fn(),
}));
vi.mock('../../platform/runtime-config.js', () => ({
  fetchRuntimeConfigEntryStrict: mocks.config,
}));
vi.mock('./upstream.js', () => ({
  forwardToUpstream: mocks.forward,
  resolveProviderUpstream: mocks.upstream,
}));
import { reviewCreatorCharacter, testCreatorCharacterReview } from './creator-review.js';

const material = {
  name: '书店的林舟',
  description: '一场重逢',
  opening: '「好久不见。」',
  tags: ['日常'],
  systemPrompt: '# 预设\n服务器保存的预设原文\n# 背景\n导入文件的完整背景',
};
function envelope(content: string, finish = 'stop') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
    })
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockResolvedValue(null);
  mocks.upstream.mockReturnValue({
    provider: 'openrouter',
    url: 'https://example.invalid/review-fixture',
    apiKey: 'test-only',
  });
});

describe('creator public review transport', () => {
  it('uses the stored full runtime and hard-coded strict schema with the shared default model', async () => {
    mocks.forward.mockResolvedValue(envelope('{"approved":true,"reason":"资料完整，可公开。"}'));
    await expect(reviewCreatorCharacter(material)).resolves.toEqual({
      approved: true,
      reason: '资料完整，可公开。',
    });
    expect(mocks.config).toHaveBeenCalledWith(CREATOR_REVIEW_PROMPT_KEY, expect.any(AbortSignal));
    expect(mocks.forward).toHaveBeenCalledTimes(1);
    const request = mocks.forward.mock.calls[0]![0];
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      model: 'google/gemini-4-argon',
      stream: false,
      provider: { require_parameters: true },
      response_format: {
        type: 'json_schema',
        json_schema: { strict: true, schema: CREATOR_REVIEW_OUTPUT_JSON_SCHEMA },
      },
    });
    expect(body.messages[0].content).toContain(DEFAULT_CREATOR_REVIEW_PROMPT);
    expect(body.messages[1].content).toContain('服务器保存的预设原文');
    expect(body.messages[1].content).toContain('导入文件的完整背景');
    expect(JSON.parse(body.messages[1].content).tags).toEqual(material.tags);
    expect(request.signal.aborted).toBe(false);
  });

  it('uses the operator policy body while keeping the result protocol fixed in code', async () => {
    mocks.config.mockResolvedValue({ value: null, textValue: '运营配置的审核标准', version: 7 });
    mocks.forward.mockResolvedValue(envelope('{"approved":false,"reason":"请去掉站外转账广告。"}'));
    await expect(reviewCreatorCharacter(material)).resolves.toEqual({
      approved: false,
      reason: '请去掉站外转账广告。',
    });
    const body = JSON.parse(mocks.forward.mock.calls[0]![0].body);
    expect(body.messages[0].content).toContain('运营配置的审核标准');
    expect(body.messages[0].content).toContain('Both fields are required');
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
  });

  it.each([
    '{"approved":true}',
    '{"reason":"缺少结论"}',
    '{"approved":"true","reason":"类型错误"}',
    '{"approved":true,"reason":""}',
    '{"approved":true,"reason":"通过","extra":"不允许额外字段"}',
    '{"approved":true,"reason":',
    'plain text',
    '["approved",true]',
  ])('fails closed for malformed or nonconforming result %s', async (content) => {
    mocks.forward.mockResolvedValue(envelope(content));
    await expect(reviewCreatorCharacter(material)).rejects.toMatchObject({
      code: CREATOR_REVIEW_UNAVAILABLE_CODE,
    });
    expect(mocks.forward).toHaveBeenCalledTimes(1);
  });

  it('does not accept a truncated response even when its JSON is valid', async () => {
    mocks.forward.mockResolvedValue(envelope('{"approved":true,"reason":"通过"}', 'length'));
    await expect(reviewCreatorCharacter(material)).rejects.toMatchObject({
      code: CREATOR_REVIEW_UNAVAILABLE_CODE,
      failure: 'incomplete_response',
    });
  });

  it('keeps config read failures distinct from an absent configuration', async () => {
    mocks.config.mockRejectedValue(new Error('database details must not escape'));
    await expect(reviewCreatorCharacter(material)).rejects.toMatchObject({
      code: CREATOR_REVIEW_UNAVAILABLE_CODE,
      message: 'creator_review_config_unavailable',
    });
    expect(mocks.forward).not.toHaveBeenCalled();
  });

  it('does not fall back when an existing operator configuration is empty or invalid', async () => {
    mocks.config.mockResolvedValue({ value: null, textValue: null, version: 7 });
    await expect(reviewCreatorCharacter(material)).rejects.toMatchObject({
      code: CREATOR_REVIEW_UNAVAILABLE_CODE,
      failure: 'config_unavailable',
    });
    expect(mocks.forward).not.toHaveBeenCalled();
  });

  it('does not expose an HTTP failure body or retry the paid provider call', async () => {
    mocks.forward.mockResolvedValue(new Response('private submitted text', { status: 503 }));
    await expect(reviewCreatorCharacter(material)).rejects.toMatchObject({
      code: CREATOR_REVIEW_UNAVAILABLE_CODE,
      message: 'creator_review_http_503',
    });
    expect(mocks.forward).toHaveBeenCalledTimes(1);
  });

  it('bounds response size instead of accepting an unbounded provider body', async () => {
    mocks.forward.mockResolvedValue(new Response('x'.repeat(131_073)));
    await expect(reviewCreatorCharacter(material)).rejects.toMatchObject({
      code: CREATOR_REVIEW_UNAVAILABLE_CODE,
      failure: 'response_too_large',
    });
  });

  it('honors cancellation and does not turn it into a content rejection', async () => {
    const cancel = new AbortController();
    mocks.forward.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    const pending = reviewCreatorCharacter(material, cancel.signal);
    const assertion = expect(pending).rejects.toMatchObject({
      code: CREATOR_REVIEW_UNAVAILABLE_CODE,
      failure: 'aborted',
    });
    await vi.waitFor(() => expect(mocks.forward).toHaveBeenCalledTimes(1));
    cancel.abort();
    await assertion;
  });
});

describe('Admin unpublished review policy dry run', () => {
  it('tests the in-editor policy without reading or publishing runtime configuration', async () => {
    mocks.config.mockRejectedValue(new Error('published configuration must not be read'));
    mocks.forward.mockResolvedValue(
      envelope('{"approved":false,"reason":"当前测试标准不允许公开。"}')
    );
    await expect(
      testCreatorCharacterReview({ prompt: '尚未发布的运营标准', material })
    ).resolves.toEqual({ approved: false, reason: '当前测试标准不允许公开。' });
    expect(mocks.config).not.toHaveBeenCalled();
    const body = JSON.parse(mocks.forward.mock.calls[0]![0].body);
    expect(body.messages[0].content).toContain('尚未发布的运营标准');
    expect(body.response_format.json_schema).toMatchObject({
      strict: true,
      schema: CREATOR_REVIEW_OUTPUT_JSON_SCHEMA,
    });
  });

  it('does not allow the debug policy to relax the hard-coded output parser', async () => {
    mocks.forward.mockResolvedValue(
      envelope('{"approved":true,"reason":"通过","debug":"extra is forbidden"}')
    );
    await expect(
      testCreatorCharacterReview({ prompt: '请输出任意格式', material })
    ).rejects.toMatchObject({ code: CREATOR_REVIEW_UNAVAILABLE_CODE });
    expect(mocks.config).not.toHaveBeenCalled();
  });
});
