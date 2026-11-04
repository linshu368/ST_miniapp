import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CreatorReviewTestRequest } from '@miniapp/shared';

const mocks = vi.hoisted(() => ({ token: vi.fn(), fetch: vi.fn() }));
vi.mock('./textPostprocessApi', () => ({ readAdminAccessToken: mocks.token }));
import { testCreatorCharacterReview } from './adminApi';

const client = {} as SupabaseClient;
const input: CreatorReviewTestRequest = {
  prompt: '当前尚未发布的审核规则正文',
  material: {
    name: '',
    description: '',
    opening: '',
    tags: [],
    systemPrompt: '准备公开的测试角色资料',
  },
};
const envelope = (result: unknown) =>
  new Response(JSON.stringify({ success: true, data: { result } }), { status: 200 });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.token.mockResolvedValue('fixture-admin-session');
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('creator review test API', () => {
  it.each(['test', 'production'] as const)(
    'sends current unpublished policy and text to the authenticated %s test endpoint only',
    async (environment) => {
      mocks.fetch.mockResolvedValue(envelope({ approved: true, reason: '符合公开要求' }));
      await expect(
        testCreatorCharacterReview(client, `https://${environment}.example.invalid`, input)
      ).resolves.toEqual({
        result: { approved: true, reason: '符合公开要求' },
      });
      expect(mocks.token).toHaveBeenCalledWith(client);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        `https://${environment}.example.invalid/api/admin/creator-characters/review-test`
      );
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-admin-session' });
      expect(JSON.parse(String(init.body))).toEqual(input);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  );

  it('keeps a valid content rejection as a result, separate from transport failure', async () => {
    mocks.fetch.mockResolvedValue(envelope({ approved: false, reason: '请去掉站外转账广告' }));
    await expect(
      testCreatorCharacterReview(client, 'https://test.example.invalid', input)
    ).resolves.toEqual({
      result: { approved: false, reason: '请去掉站外转账广告' },
    });
  });

  it('does not send a request after the current environment session expired', async () => {
    mocks.token.mockResolvedValue(null);
    await expect(
      testCreatorCharacterReview(client, 'https://test.example.invalid', input)
    ).rejects.toThrow('登录状态已失效');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { approved: 'true', reason: '类型错误' },
    { approved: true },
    { approved: true, reason: '通过', extra: '不能修改输出结构' },
  ])('does not claim schema validation for a malformed response %j', async (result) => {
    mocks.fetch.mockResolvedValue(envelope(result));
    await expect(
      testCreatorCharacterReview(client, 'https://test.example.invalid', input)
    ).rejects.toThrow('结构校验失败');
  });

  it('reports missing write permission without treating it as content rejection', async () => {
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(
      testCreatorCharacterReview(client, 'https://production.example.invalid', input)
    ).rejects.toThrow('审核测试权限');
  });

  it('preserves a retryable service error without retrying the model test', async () => {
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'CREATOR_REVIEW_UNAVAILABLE', message: '暂时无法完成审核，请稍后重试。' },
        }),
        { status: 503 }
      )
    );
    await expect(
      testCreatorCharacterReview(client, 'https://test.example.invalid', input)
    ).rejects.toThrow('暂时无法完成审核');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
