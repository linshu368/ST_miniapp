import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, type FetchQueryOptions, type MutationOptions } from '@tanstack/react-query';
import type {
  GetSessionVoiceData,
  GetSessionImagesData,
  MessageVoice,
  MessageImageAttempt,
  GetImagePlazaConversationData,
  ImagePlazaAttempt,
  ImagePlazaQuoteData,
  ImagePlazaQuoteRequest,
  SubmitImagePlazaAttemptData,
  SubmitImagePlazaAttemptRequest,
  ShareImagePlazaWorkData,
  ShareImagePlazaWorkRequest,
} from '@miniapp/shared';
import { apiClient } from './client';
import { useSessionVoiceQuery, useGenerateVoiceMutation, voiceKeys } from './voice';
import { useSessionImagesQuery, useCreateMessageImageMutation, imageKeys } from './images';
import {
  imagePlazaKeys,
  useImagePlazaConversationQuery,
  useImagePlazaQuoteMutation,
  useSubmitImagePlazaAttemptMutation,
  useShareImagePlazaMutation,
} from './image-plaza';

const hooks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), client: vi.fn() }));
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQuery: hooks.query,
  useMutation: hooks.mutation,
  useQueryClient: hooks.client,
}));
vi.mock('./client', () => ({ apiClient: vi.fn(), ApiClientError: class extends Error {} }));
vi.mock('./payment', () => ({ paymentKeys: { wallet: () => ['wallet'] } }));

const voice = (status: MessageVoice['status']): MessageVoice => ({
  message_id: 'm1',
  status,
  audio_url: null,
  duration_ms: null,
  spoken_text: null,
  voice_id: 'v1',
  error_code: null,
  last_error_code: null,
  credits_charged: 0,
  billing_mode: 'free_trial',
  free_trial_ordinal: 3,
  price_credits: 15,
  price_label: '15 星尘',
  created_at: '2026-09-23T12:00:00Z',
});
const attempt = (status: MessageImageAttempt['status']): MessageImageAttempt => ({
  id: 'i1',
  message_id: 'm1',
  attempt_no: 1,
  tier: 'basic',
  status,
  prompt_cn: '风景',
  prompt_source: 'custom',
  image_url: null,
  width: 512,
  height: 768,
  mime_type: null,
  byte_size: null,
  error_code: null,
  credits_charged: 0,
  billing_mode: 'free_trial',
  free_trial_ordinal: 3,
  price_credits: 30,
  price_label: '30 星尘',
  wallet_policy: 'main_only',
  vip_valid_until: null,
  created_at: '2026-09-23T12:00:00Z',
  updated_at: '2026-09-23T12:00:00Z',
  completed_at: null,
});
const imageData = (status: MessageImageAttempt['status']): GetSessionImagesData => ({
  images: [
    {
      message_id: 'm1',
      current: status === 'ready' ? attempt(status) : null,
      latest: attempt(status),
    },
  ],
});

let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  hooks.client.mockReturnValue(client);
  client.setQueryData(voiceKeys.config, { next: 'cached' });
  client.setQueryData(imageKeys.config, { next: 'cached' });
  client.setQueryData(['wallet'], { balance: 100 });
});
afterEach(() => client.clear());

describe('media settlement cache refresh', () => {
  it.each(['ready', 'failed'] as const)(
    'refreshes voice quota and wallet on %s once, including free attempts',
    async (status) => {
      client.setQueryData(voiceKeys.session('s1'), { audio: [voice('pending')] });
      useSessionVoiceQuery('s1');
      const options = hooks.query.mock.calls[0]![0] as FetchQueryOptions<GetSessionVoiceData>;
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      vi.mocked(apiClient).mockResolvedValue({ audio: [voice(status)] });
      await client.fetchQuery(options);
      expect(client.getQueryState(voiceKeys.config)?.isInvalidated).toBe(true);
      expect(client.getQueryState(imageKeys.config)?.isInvalidated).toBe(false);
      expect(client.getQueryState(['wallet'])?.isInvalidated).toBe(true);
      expect(invalidate).toHaveBeenCalledTimes(2);
      await client.fetchQuery(options);
      expect(invalidate).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['ready', 'failed', 'failed_unknown'] as const)(
    'refreshes image quota and wallet on %s without touching voice quota',
    async (status) => {
      client.setQueryData(imageKeys.session('s1'), imageData('generating'));
      useSessionImagesQuery('s1');
      const options = hooks.query.mock.calls[0]![0] as FetchQueryOptions<GetSessionImagesData>;
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      vi.mocked(apiClient).mockResolvedValue(imageData(status));
      await client.fetchQuery(options);
      expect(client.getQueryState(imageKeys.config)?.isInvalidated).toBe(true);
      expect(client.getQueryState(voiceKeys.config)?.isInvalidated).toBe(false);
      expect(client.getQueryState(['wallet'])?.isInvalidated).toBe(true);
      await client.fetchQuery(options);
      expect(invalidate).toHaveBeenCalledTimes(2);
    }
  );

  it('does not refetch quotes for every pending poll', async () => {
    client.setQueryData(voiceKeys.session('s1'), { audio: [voice('pending')] });
    useSessionVoiceQuery('s1');
    vi.mocked(apiClient).mockResolvedValue({ audio: [voice('pending')] });
    await client.fetchQuery(
      hooks.query.mock.calls[0]![0] as FetchQueryOptions<GetSessionVoiceData>
    );
    expect(client.getQueryState(voiceKeys.config)?.isInvalidated).toBe(false);
    expect(client.getQueryState(['wallet'])?.isInvalidated).toBe(false);
  });

  it('invalidates the corresponding next quote when an attempt is accepted', () => {
    useGenerateVoiceMutation('s1');
    const voiceMutation = hooks.mutation.mock.calls[0]![0] as {
      onSuccess: (data: { audio: MessageVoice }) => void;
    };
    voiceMutation.onSuccess({ audio: voice('pending') });
    expect(client.getQueryState(voiceKeys.config)?.isInvalidated).toBe(true);
    expect(client.getQueryState(imageKeys.config)?.isInvalidated).toBe(false);
    expect(
      client.getQueryData<GetSessionVoiceData>(voiceKeys.session('s1'))?.audio[0]?.status
    ).toBe('pending');
    useCreateMessageImageMutation('s1');
    const imageMutation = hooks.mutation.mock.calls[1]![0] as {
      onSuccess: (data: { attempt: MessageImageAttempt }) => void;
    };
    imageMutation.onSuccess({ attempt: attempt('pending') });
    expect(client.getQueryState(imageKeys.config)?.isInvalidated).toBe(true);
  });

  it('refreshes quotas after a rejected or uncertain submission so released reservations are visible', () => {
    useGenerateVoiceMutation('s1');
    const voiceMutation = hooks.mutation.mock.calls[0]![0] as { onError: () => void };
    voiceMutation.onError();
    expect(client.getQueryState(voiceKeys.config)?.isInvalidated).toBe(true);
    expect(client.getQueryState(imageKeys.config)?.isInvalidated).toBe(false);
    useCreateMessageImageMutation('s1');
    const imageMutation = hooks.mutation.mock.calls[1]![0] as { onError: () => void };
    imageMutation.onError();
    expect(client.getQueryState(imageKeys.config)?.isInvalidated).toBe(true);
  });
});

const plazaConversationId = '11111111-1111-4111-8111-111111111111';
const plazaAttemptId = '22222222-2222-4222-8222-222222222222';
const plazaQuoteId = '33333333-3333-4333-8333-333333333333';
const plazaArtifactId = '44444444-4444-4444-8444-444444444444';
const plazaSnapshot = {
  prompt: '一枚白色陶瓷杯',
  model_id: 'preview-model',
  aspect_ratio: '1:1' as const,
  resolution: '1K' as const,
  reasoning: false,
  auto_optimize: true,
  reference_artifact_id: null,
  mode: 't2i' as const,
  style: 'None' as const,
};
function plazaAttempt(status: ImagePlazaAttempt['status'], id = plazaAttemptId): ImagePlazaAttempt {
  return {
    id,
    conversation_id: plazaConversationId,
    status,
    quote_credits: 10,
    error_code: status === 'failed' || status === 'failed_unknown' ? 'preview_failure' : null,
    artifacts:
      status === 'ready'
        ? [
            {
              id: plazaArtifactId,
              image_url: 'https://images.example.test/generated.webp',
              width: 512,
              height: 512,
            },
          ]
        : [],
    created_at: '2026-10-23T00:00:00Z',
    updated_at: '2026-10-23T00:00:01Z',
  };
}
function plazaData(...attempts: ImagePlazaAttempt[]): GetImagePlazaConversationData {
  return {
    conversation: {
      id: plazaConversationId,
      title: 'Virtual generation',
      snapshot: plazaSnapshot,
      messages: attempts.map((item) => ({
        id: item.id,
        role: 'assistant',
        media_type: 'image',
        content: item.status === 'ready' ? '生成完成' : '生成中',
        attempt: item,
        video_attempt: null,
        created_at: item.created_at,
      })),
      created_at: '2026-10-23T00:00:00Z',
      updated_at: '2026-10-23T00:00:01Z',
    },
  };
}
function usePlazaQueryOptions() {
  useImagePlazaConversationQuery(plazaConversationId);
  return hooks.query.mock.lastCall![0] as FetchQueryOptions<GetImagePlazaConversationData>;
}
function shareData(reward: number): ShareImagePlazaWorkData {
  return {
    work: {
      id: '55555555-5555-4555-8555-555555555555',
      media_type: 'image',
      title: 'Virtual artwork',
      image_url: 'https://images.example.test/generated.webp',
      reference_image_url: null,
      model_id: plazaSnapshot.model_id,
      model_name: 'Preview model',
      width: 512,
      height: 512,
      tags: [],
      liked: false,
      like_count: 0,
      published_at: '2026-10-23T00:00:02Z',
      snapshot: plazaSnapshot,
    },
    reward_credits: reward,
    already_shared: reward === 0,
    has_completed_first_share: true,
  };
}

describe('image plaza settlement cache refresh', () => {
  it('uses real quote and submit paths and quoted fields without refreshing the wallet at acceptance', async () => {
    const quoted: ImagePlazaQuoteData = {
      quote_id: plazaQuoteId,
      model_id: plazaSnapshot.model_id,
      aspect_ratio: '1:1',
      resolution: '1K',
      credits: 10,
      expires_at: '2026-10-23T00:05:00Z',
    };
    const quoteBody: ImagePlazaQuoteRequest = {
      model_id: plazaSnapshot.model_id,
      aspect_ratio: '1:1',
      resolution: '1K',
      mode: 't2i',
    };
    vi.mocked(apiClient)
      .mockResolvedValueOnce(quoted)
      .mockResolvedValueOnce({
        attempt: plazaAttempt('pending'),
      });
    useImagePlazaQuoteMutation();
    const quoteOptions = hooks.mutation.mock.lastCall![0] as MutationOptions<
      ImagePlazaQuoteData,
      Error,
      ImagePlazaQuoteRequest
    >;
    const received = await client.getMutationCache().build(client, quoteOptions).execute(quoteBody);
    const submitBody: SubmitImagePlazaAttemptRequest = {
      ...quoteBody,
      prompt: plazaSnapshot.prompt,
      reasoning: false,
      auto_optimize: true,
      reference_artifact_id: null,
      quote_id: received.quote_id,
      idempotency_key: '66666666-6666-4666-8666-666666666666',
    };
    client.setQueryData(imagePlazaKeys.conversation(plazaConversationId), plazaData());
    useSubmitImagePlazaAttemptMutation(plazaConversationId);
    const submitOptions = hooks.mutation.mock.lastCall![0] as MutationOptions<
      SubmitImagePlazaAttemptData,
      Error,
      SubmitImagePlazaAttemptRequest
    >;
    const accepted = await client
      .getMutationCache()
      .build(client, submitOptions)
      .execute(submitBody);
    expect(accepted.attempt.status).toBe('pending');
    expect(apiClient).toHaveBeenNthCalledWith(1, '/api/image-plaza/quotes', {
      method: 'POST',
      body: JSON.stringify(quoteBody),
    });
    expect(apiClient).toHaveBeenNthCalledWith(
      2,
      `/api/image-plaza/conversations/${plazaConversationId}/attempts`,
      {
        method: 'POST',
        body: JSON.stringify(submitBody),
      }
    );
    expect(apiClient).toHaveBeenCalledTimes(2);
    expect(
      client.getQueryState(imagePlazaKeys.conversation(plazaConversationId))?.isInvalidated
    ).toBe(true);
    expect(client.getQueryState(['wallet'])?.isInvalidated).toBe(false);
  });

  it.each(['pending', 'generating', 'failed', 'failed_unknown'] as const)(
    'does not refresh the wallet on %s or repeat any submission while reading status',
    async (status) => {
      client.setQueryData(
        imagePlazaKeys.conversation(plazaConversationId),
        plazaData(plazaAttempt('pending'))
      );
      const options = usePlazaQueryOptions();
      vi.mocked(apiClient).mockResolvedValue(plazaData(plazaAttempt(status)));
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      await client.fetchQuery(options);
      await client.fetchQuery(options);
      expect(invalidate).not.toHaveBeenCalled();
      expect(client.getQueryState(['wallet'])?.isInvalidated).toBe(false);
      expect(apiClient).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(apiClient).mock.calls) {
        expect(call).toEqual([
          `/api/image-plaza/conversations/${plazaConversationId}?include_video=1`,
          { signal: expect.any(AbortSignal) },
        ]);
      }
    }
  );

  it('refreshes wallet and its spending child once when generation first becomes ready', async () => {
    client.setQueryData(['wallet', 'spending'], { items: [] });
    client.setQueryData(
      imagePlazaKeys.conversation(plazaConversationId),
      plazaData(plazaAttempt('generating'))
    );
    const options = usePlazaQueryOptions();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue(plazaData(plazaAttempt('ready')));
    await client.fetchQuery(options);
    expect(client.getQueryState(['wallet'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['wallet', 'spending'])?.isInvalidated).toBe(true);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['wallet'] });
    await client.fetchQuery(options);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(imageKeys.config)?.isInvalidated).toBe(false);
    expect(client.getQueryState(voiceKeys.config)?.isInvalidated).toBe(false);
  });

  it('detects completion after query recreation over the cache left when leaving the page', async () => {
    const previousOptions = usePlazaQueryOptions();
    vi.mocked(apiClient).mockResolvedValueOnce(plazaData(plazaAttempt('pending')));
    await client.fetchQuery(previousOptions);
    expect(client.getQueryState(['wallet'])?.isInvalidated).toBe(false);
    // The component is gone; only QueryClient survives navigation, with its pending snapshot.
    const returnedOptions = usePlazaQueryOptions();
    vi.mocked(apiClient).mockResolvedValue(plazaData(plazaAttempt('ready')));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await client.fetchQuery(returnedOptions);
    await client.fetchQuery(returnedOptions);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['wallet'] });
  });

  it('refreshes on the first uncached ready read but not identical historical results', async () => {
    const options = usePlazaQueryOptions();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue(plazaData(plazaAttempt('ready')));
    await client.fetchQuery(options);
    await client.fetchQuery(usePlazaQueryOptions());
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['wallet'] });
  });

  it('ignores an old ready task during pending polls and batches newly completed tasks', async () => {
    const old = plazaAttempt('ready');
    const secondId = '77777777-7777-4777-8777-777777777777';
    const thirdId = '88888888-8888-4888-8888-888888888888';
    client.setQueryData(imagePlazaKeys.conversation(plazaConversationId), plazaData(old));
    const options = usePlazaQueryOptions();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValueOnce(plazaData(old, plazaAttempt('pending', secondId)));
    await client.fetchQuery(options);
    expect(invalidate).not.toHaveBeenCalled();
    vi.mocked(apiClient).mockResolvedValue(
      plazaData(old, plazaAttempt('ready', secondId), plazaAttempt('ready', thirdId))
    );
    await client.fetchQuery(options);
    await client.fetchQuery(options);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['wallet'] });
  });

  it('preserves cached tasks and does not refresh the wallet when a status read fails', async () => {
    const before = plazaData(plazaAttempt('generating'));
    client.setQueryData(imagePlazaKeys.conversation(plazaConversationId), before);
    const options = usePlazaQueryOptions();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    vi.mocked(apiClient).mockRejectedValueOnce(new Error('preview offline'));
    await expect(client.fetchQuery(options)).rejects.toThrow('preview offline');
    expect(client.getQueryData(imagePlazaKeys.conversation(plazaConversationId))).toEqual(before);
    expect(invalidate).not.toHaveBeenCalled();
    expect(apiClient).toHaveBeenCalledExactlyOnceWith(
      `/api/image-plaza/conversations/${plazaConversationId}?include_video=1`,
      { signal: expect.any(AbortSignal) }
    );
  });

  it('keeps failed submissions single-shot and leaves the wallet cache unchanged', async () => {
    vi.mocked(apiClient).mockRejectedValueOnce(new Error('preview timeout'));
    useSubmitImagePlazaAttemptMutation(plazaConversationId);
    const options = hooks.mutation.mock.lastCall![0] as MutationOptions<
      SubmitImagePlazaAttemptData,
      Error,
      SubmitImagePlazaAttemptRequest
    >;
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await expect(
      client
        .getMutationCache()
        .build(client, options)
        .execute({
          ...plazaSnapshot,
          quote_id: plazaQuoteId,
          idempotency_key: '99999999-9999-4999-8999-999999999999',
        })
    ).rejects.toThrow('preview timeout');
    expect(apiClient).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each([10, 0])(
    'refreshes the wallet along with plaza caches after a successful share with reward %s',
    async (reward) => {
      client.setQueryData(imagePlazaKeys.config(), { enabled: true });
      client.setQueryData(imagePlazaKeys.feed('', 'all'), { pages: [], pageParams: [] });
      vi.mocked(apiClient).mockResolvedValueOnce(shareData(reward));
      useShareImagePlazaMutation();
      const options = hooks.mutation.mock.lastCall![0] as MutationOptions<
        ShareImagePlazaWorkData,
        Error,
        ShareImagePlazaWorkRequest
      >;
      const body: ShareImagePlazaWorkRequest = {
        artifact_id: plazaArtifactId,
        title: 'Virtual artwork',
        tags: [],
      };
      await client.getMutationCache().build(client, options).execute(body);
      expect(apiClient).toHaveBeenCalledExactlyOnceWith('/api/image-plaza/share', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      expect(client.getQueryState(['wallet'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(imagePlazaKeys.config())?.isInvalidated).toBe(true);
      expect(client.getQueryState(imagePlazaKeys.feed('', 'all'))?.isInvalidated).toBe(true);
    }
  );

  it('does not claim a wallet change after sharing fails', async () => {
    vi.mocked(apiClient).mockRejectedValueOnce(new Error('preview share rejected'));
    useShareImagePlazaMutation();
    const options = hooks.mutation.mock.lastCall![0] as MutationOptions<
      ShareImagePlazaWorkData,
      Error,
      ShareImagePlazaWorkRequest
    >;
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await expect(
      client.getMutationCache().build(client, options).execute({
        artifact_id: plazaArtifactId,
        title: 'Virtual artwork',
        tags: [],
      })
    ).rejects.toThrow('preview share rejected');
    expect(invalidate).not.toHaveBeenCalled();
  });
});
