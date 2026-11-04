'use client';

import { useEffect } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  CreatePaymentOrderData,
  CreatePaymentOrderRequest,
  GetDailyCheckinData,
  GetPaymentOrderData,
  GetPaymentOrdersData,
  GetPaymentOrdersQuery,
  GetPaymentPlansData,
  GetWalletBalanceData,
  GetWalletSpendingData,
  PaymentOrderStatus,
  PostDailyCheckinData,
} from '@miniapp/shared';

import { apiClient } from './client';
import { useRefetchOnForeground } from './use-refetch-on-foreground';

// ==== Query Keys ====
export const paymentKeys = {
  all: ['payment'] as const,
  plans: () => [...paymentKeys.all, 'plans'] as const,
  orders: () => [...paymentKeys.all, 'orders'] as const,
  ordersList: (status: PaymentOrderStatus | 'all') =>
    [...paymentKeys.orders(), 'list', status] as const,
  order: (id: string) => [...paymentKeys.orders(), 'detail', id] as const,
  wallet: () => [...paymentKeys.all, 'wallet'] as const,
  spending: () => [...paymentKeys.wallet(), 'spending'] as const,
  checkin: () => [...paymentKeys.wallet(), 'checkin'] as const,
};

// ==== 纯 fetch 函数（私有）====

async function fetchPlans(): Promise<GetPaymentPlansData> {
  return apiClient<GetPaymentPlansData>('/api/payment/plans');
}

async function fetchOrder(id: string): Promise<GetPaymentOrderData> {
  return apiClient<GetPaymentOrderData>(`/api/payment/orders/${encodeURIComponent(id)}`);
}

async function fetchOrders(query: GetPaymentOrdersQuery): Promise<GetPaymentOrdersData> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return apiClient<GetPaymentOrdersData>(`/api/payment/orders${qs ? `?${qs}` : ''}`);
}

async function postCreateOrder(body: CreatePaymentOrderRequest): Promise<CreatePaymentOrderData> {
  return apiClient<CreatePaymentOrderData>('/api/payment/orders', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function fetchWalletBalance(signal?: AbortSignal): Promise<GetWalletBalanceData> {
  // Profile shell 不等待余额，但余额卡仍是首屏唯一立即读取的数据；保留 critical 槽，
  // 避免签到、VIP、社区等次级读取先占满连接后让金额长时间停在占位态。
  return apiClient<GetWalletBalanceData>('/api/wallet/balance', {
    queuePriority: 'critical',
    signal,
  });
}

async function fetchWalletSpending(): Promise<GetWalletSpendingData> {
  return apiClient<GetWalletSpendingData>('/api/wallet/spending');
}

async function fetchDailyCheckin(): Promise<GetDailyCheckinData> {
  return apiClient<GetDailyCheckinData>('/api/wallet/checkin');
}

async function postDailyCheckin(): Promise<PostDailyCheckinData> {
  return apiClient<PostDailyCheckinData>('/api/wallet/checkin', {
    method: 'POST',
  });
}

// ==== React Query hooks（业务层唯一入口）====

export function usePaymentPlansQuery({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<GetPaymentPlansData>({
    queryKey: paymentKeys.plans(),
    queryFn: fetchPlans,
    enabled,
    // 响应同时包含运营可热更的余额不足提示语，每次进入充值页都拉取最新值。
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

/** 下单：成功后把订单塞进 cache 供详情页秒开，并 invalidate 列表 */
export function useCreatePaymentOrderMutation() {
  const qc = useQueryClient();
  return useMutation<CreatePaymentOrderData, Error, CreatePaymentOrderRequest>({
    mutationFn: postCreateOrder,
    onSuccess: (data) => {
      qc.setQueryData<GetPaymentOrderData>(paymentKeys.order(data.order.id), {
        order: data.order,
      });
      void qc.invalidateQueries({ queryKey: paymentKeys.orders() });
    },
  });
}

/** 订单详情 + 2s 轮询；pending 轮询、其它状态停 */
export function usePaymentOrderQuery(orderId: string | undefined) {
  return useQuery<GetPaymentOrderData>({
    queryKey: orderId ? paymentKeys.order(orderId) : paymentKeys.orders(),
    enabled: !!orderId,
    queryFn: async () => {
      if (!orderId) throw new Error('order id is required');
      return fetchOrder(orderId);
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 2_000;
      return data.order.status === 'pending' ? 2_000 : false;
    },
    // 支付中页可见时保持轮询，避免返回再进跳失准
    refetchIntervalInBackground: false,
  });
}

export function useWalletBalanceQuery() {
  return useQuery<GetWalletBalanceData>({
    queryKey: paymentKeys.wallet(),
    queryFn: ({ signal }) => fetchWalletBalance(signal),
    staleTime: 15_000,
  });
}

export function prefetchWalletBalanceQuery(queryClient: QueryClient): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: paymentKeys.wallet(),
    queryFn: ({ signal }) => fetchWalletBalance(signal),
    staleTime: 15_000,
  });
}

export function useWalletCredits(): number {
  const { data } = useWalletBalanceQuery();
  return data?.credits ?? 0;
}

export function useWalletSpendingQuery() {
  return useQuery<GetWalletSpendingData>({
    queryKey: paymentKeys.spending(),
    queryFn: fetchWalletSpending,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === 'pending') ? 3_000 : false,
  });
}

export function useDailyCheckinQuery({ enabled = true }: { enabled?: boolean } = {}) {
  const query = useQuery<GetDailyCheckinData>({
    queryKey: paymentKeys.checkin(),
    queryFn: fetchDailyCheckin,
    enabled,
    staleTime: 30_000,
  });
  const { refetch } = query;
  useRefetchOnForeground(refetch, enabled);
  const canClaim = query.data?.checkin.can_claim;
  const nextClaimAt = query.data?.checkin.next_claim_at;
  useEffect(() => {
    if (canClaim !== false || !nextClaimAt) return;
    const waitMs = Date.parse(nextClaimAt) - Date.now();
    if (!Number.isFinite(waitMs)) return;
    // 跨零点只回读一次服务端资格；不在客户端发奖或增加常驻轮询。
    const timer = window.setTimeout(
      () => void refetch({ cancelRefetch: false }),
      Math.max(0, waitMs) + 100
    );
    return () => window.clearTimeout(timer);
  }, [canClaim, enabled, nextClaimAt, refetch]);
  return query;
}

export function useDailyCheckinMutation() {
  const qc = useQueryClient();
  return useMutation<PostDailyCheckinData, Error>({
    mutationFn: postDailyCheckin,
    onSuccess: (data) => {
      qc.setQueryData<GetWalletBalanceData>(paymentKeys.wallet(), data.wallet);
      // 先用已到账结果收起领取入口，不必等待后续读取才能显示已签到。
      qc.setQueryData<GetDailyCheckinData>(paymentKeys.checkin(), {
        checkin: {
          can_claim: false,
          last_claimed_at: data.checkin.claimed_at,
          next_claim_at: data.checkin.next_claim_at,
          reward_credits: data.checkin.reward_credits,
          base_reward_credits: data.checkin.base_reward_credits,
          vip_reward_credits: data.checkin.vip_reward_credits,
        },
      });
      void qc.invalidateQueries({ queryKey: paymentKeys.checkin() });
    },
  });
}

/** 流水列表：游标分页无限滚动 */
export function usePaymentOrdersInfiniteQuery(
  statusFilter: PaymentOrderStatus | 'all' = 'all',
  pageSize = 20
) {
  return useInfiniteQuery<
    GetPaymentOrdersData,
    Error,
    InfiniteData<GetPaymentOrdersData, string | undefined>,
    ReturnType<typeof paymentKeys.ordersList>,
    string | undefined
  >({
    queryKey: paymentKeys.ordersList(statusFilter),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      const query: GetPaymentOrdersQuery = {
        limit: pageSize,
        ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      };
      return fetchOrders(query);
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}
