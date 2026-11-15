import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QueryClient,
  type MutationOptions,
  type QueryFunctionContext,
} from '@tanstack/react-query';
import type {
  CommunityEntryData,
  GetDailyCheckinData,
  GetWalletBalanceData,
  PostDailyCheckinData,
  VerifyCommunityMembershipData,
} from '@miniapp/shared';
import { apiClient } from './client';
import { paymentKeys, useDailyCheckinMutation } from './payment';
import { communityKeys, useVerifyCommunityMembershipMutation } from './community';
import { notificationKeys, prefetchNotifications, useNotificationsQuery } from './notifications';

const hooks = vi.hoisted(() => ({ mutation: vi.fn(), client: vi.fn(), query: vi.fn() }));
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useMutation: hooks.mutation,
  useQueryClient: hooks.client,
  useQuery: hooks.query,
}));
vi.mock('./use-refetch-on-foreground', () => ({ useRefetchOnForeground: vi.fn() }));
vi.mock('./client', () => ({ apiClient: vi.fn(), ApiClientError: class extends Error {} }));

const wallet: GetWalletBalanceData = {
  credits: 100,
  main_credits: 80,
  bonus_credits: 20,
  total_credits: 100,
  first_paid_at: null,
  last_paid_at: null,
  total_paid_amount: '0',
};
const checkin: GetDailyCheckinData = {
  checkin: { can_claim: true, last_claimed_at: null, next_claim_at: null, reward_credits: 60 },
};
const community: CommunityEntryData = {
  enabled: true,
  title: '官方社群',
  description: '测试社群',
  reward_credits: 300,
  telegram_url: 'https://t.me/fixture_community',
  fallback_handle: '@fixture_community',
  claim_status: 'unclaimed',
  rewarded_at: null,
};
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  hooks.client.mockReturnValue(client);
  hooks.query.mockReturnValue({ refetch: vi.fn() });
  client.setQueryData(paymentKeys.wallet(), wallet);
  client.setQueryData(paymentKeys.checkin(), checkin);
  client.setQueryData(communityKeys.entry, community);
  client.setQueryData(notificationKeys.unread, { total: 0 });
});
afterEach(() => client.clear());

describe('message body request scheduling', () => {
  it('gives visible content the reserved slot without extending notification freshness', async () => {
    vi.mocked(apiClient).mockResolvedValue({ notifications: [] });
    useNotificationsQuery('official');
    const options = hooks.query.mock.lastCall![0] as {
      staleTime: number;
      refetchOnMount: string;
      queryFn: (context: QueryFunctionContext) => Promise<unknown>;
    };
    await options.queryFn({ signal: new AbortController().signal } as QueryFunctionContext);
    expect(apiClient).toHaveBeenCalledWith(
      '/api/notifications?scope=official',
      expect.objectContaining({ queuePriority: 'critical' })
    );
    expect(options).toMatchObject({ staleTime: 0, refetchOnMount: 'always' });
  });

  it('keeps speculative prefetch in the background and shares its in-flight query', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(apiClient).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = prefetchNotifications(client, 'personal');
    const second = prefetchNotifications(client, 'personal');
    expect(apiClient).toHaveBeenCalledOnce();
    expect(apiClient).toHaveBeenCalledWith(
      '/api/notifications?scope=personal',
      expect.objectContaining({ queuePriority: 'background' })
    );
    finish({ notifications: [] });
    await Promise.all([first, second]);
    expect(client.getQueryData(notificationKeys.list('personal'))).toEqual({ notifications: [] });
  });
});

function mutation<T>() {
  const options = hooks.mutation.mock.lastCall?.[0] as MutationOptions<T, Error, void>;
  return client.getMutationCache().build(client, options);
}

describe('profile check-in confirmed state', () => {
  it('shows claimed immediately and uses the exact server wallet instead of adding locally', async () => {
    useDailyCheckinMutation();
    const result: PostDailyCheckinData = {
      wallet: { ...wallet, credits: 40, main_credits: 20, total_credits: 40 },
      checkin: {
        claimed_at: '2026-10-23T09:00:00Z',
        next_claim_at: '2026-10-24T00:00:00Z',
        reward_credits: 120,
        base_reward_credits: 60,
        vip_reward_credits: 60,
      },
    };
    vi.mocked(apiClient).mockResolvedValue(result);
    await mutation<PostDailyCheckinData>().execute(undefined);
    expect(apiClient).toHaveBeenCalledWith('/api/wallet/checkin', { method: 'POST' });
    expect(client.getQueryData(paymentKeys.wallet())).toEqual(result.wallet);
    expect(client.getQueryData(paymentKeys.checkin())).toEqual({
      checkin: {
        can_claim: false,
        last_claimed_at: result.checkin.claimed_at,
        next_claim_at: result.checkin.next_claim_at,
        reward_credits: 120,
        base_reward_credits: 60,
        vip_reward_credits: 60,
      },
    });
    expect(client.getQueryState(paymentKeys.checkin())?.isInvalidated).toBe(true);
  });

  it('keeps a failed claim available without inventing a wallet reward', async () => {
    useDailyCheckinMutation();
    vi.mocked(apiClient).mockRejectedValue(new Error('offline'));
    await expect(mutation<PostDailyCheckinData>().execute(undefined)).rejects.toThrow('offline');
    expect(client.getQueryData(paymentKeys.checkin())).toEqual(checkin);
    expect(client.getQueryData(paymentKeys.wallet())).toEqual(wallet);
  });
});

describe('community reward entry completion', () => {
  it.each(['rewarded', 'already_rewarded'] as const)(
    'marks the entry completed after %s while preserving the rest of its data',
    async (status) => {
      useVerifyCommunityMembershipMutation();
      const result: VerifyCommunityMembershipData = {
        status,
        reward_credits: 300,
        rewarded_at: '2026-10-23T09:00:00Z',
      };
      vi.mocked(apiClient).mockResolvedValue(result);
      await mutation<VerifyCommunityMembershipData>().execute(undefined);
      expect(apiClient).toHaveBeenCalledWith('/api/community/verify-membership', {
        method: 'POST',
      });
      expect(client.getQueryData(communityKeys.entry)).toEqual({
        ...community,
        claim_status: 'rewarded',
        rewarded_at: result.rewarded_at,
      });
      expect(client.getQueryState(paymentKeys.wallet())?.isInvalidated).toBe(true);
      expect(client.getQueryData(paymentKeys.wallet())).toEqual(wallet);
      expect(client.getQueryState(notificationKeys.unread)?.isInvalidated).toBe(true);
    }
  );

  it.each(['not_member', 'pending', 'ineligible', 'disabled'] as const)(
    'keeps the entry available for %s instead of pretending the reward arrived',
    async (status) => {
      useVerifyCommunityMembershipMutation();
      vi.mocked(apiClient).mockResolvedValue({ status, reward_credits: 0, rewarded_at: null });
      await mutation<VerifyCommunityMembershipData>().execute(undefined);
      expect(client.getQueryData(communityKeys.entry)).toEqual(community);
      expect(client.getQueryState(paymentKeys.wallet())?.isInvalidated).toBe(false);
    }
  );

  it('keeps the entry after an unsuccessful request', async () => {
    useVerifyCommunityMembershipMutation();
    vi.mocked(apiClient).mockRejectedValue(new Error('offline'));
    await expect(mutation<VerifyCommunityMembershipData>().execute(undefined)).rejects.toThrow(
      'offline'
    );
    expect(client.getQueryData(communityKeys.entry)).toEqual(community);
  });

  it('does not create a partial community DTO when there is no existing entry cache', async () => {
    client.removeQueries({ queryKey: communityKeys.entry });
    useVerifyCommunityMembershipMutation();
    vi.mocked(apiClient).mockResolvedValue({
      status: 'rewarded',
      reward_credits: 300,
      rewarded_at: null,
    });
    await mutation<VerifyCommunityMembershipData>().execute(undefined);
    expect(client.getQueryData(communityKeys.entry)).toBeUndefined();
  });
});
