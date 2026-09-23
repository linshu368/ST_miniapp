import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, type FetchQueryOptions } from '@tanstack/react-query';
import type {
  GetSessionVoiceData,
  GetSessionImagesData,
  MessageVoice,
  MessageImageAttempt,
} from '@miniapp/shared';
import { apiClient } from './client';
import { useSessionVoiceQuery, useGenerateVoiceMutation, voiceKeys } from './voice';
import { useSessionImagesQuery, useCreateMessageImageMutation, imageKeys } from './images';

const hooks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), client: vi.fn() }));
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQuery: hooks.query,
  useMutation: hooks.mutation,
  useQueryClient: hooks.client,
}));
vi.mock('./client', () => ({ apiClient: vi.fn() }));
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
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
