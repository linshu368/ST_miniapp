'use client';

import { useSyncExternalStore } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type {
  CreatePaymentOrderData,
  CreatePaymentOrderRequest,
  GetPaymentOrderData,
  GetPaymentOrdersData,
  GetPaymentOrdersQuery,
  GetPaymentPlansData,
  PaymentOrderStatus,
} from '@miniapp/shared';

import { apiClient } from './client';
import { shouldUseMock } from './mock-registry';
import {
  mockCreateOrder,
  mockGetOrder,
  mockListOrders,
  mockPaymentPlans,
  mockPayUrl,
  subscribeMockPayment,
} from '@/lib/mock-data/payment';
import { mockWallet } from '@/lib/mock-data/shared';

const USE_MOCK = shouldUseMock('payment');

// ==== Query Keys ====
export const paymentKeys = {
  all: ['payment'] as const,
  plans: () => [...paymentKeys.all, 'plans'] as const,
  orders: () => [...paymentKeys.all, 'orders'] as const,
  ordersList: (status: PaymentOrderStatus | 'all') =>
    [...paymentKeys.orders(), 'list', status] as const,
  order: (id: string) => [...paymentKeys.orders(), 'detail', id] as const,
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

// ==== React Query hooks（业务层唯一入口）====

export function usePaymentPlansQuery() {
  return useQuery<GetPaymentPlansData>({
    queryKey: paymentKeys.plans(),
    queryFn: async () => {
      if (USE_MOCK) {
        return { plans: mockPaymentPlans };
      }
      return fetchPlans();
    },
    // 套餐信息相对稳定，5 分钟内不重拉
    staleTime: 5 * 60 * 1000,
  });
}

/** 下单：成功后把订单塞进 cache 供详情页秒开，并 invalidate 列表 */
export function useCreatePaymentOrderMutation() {
  const qc = useQueryClient();
  return useMutation<CreatePaymentOrderData, Error, CreatePaymentOrderRequest>({
    mutationFn: async (body) => {
      if (USE_MOCK) {
        const order = mockCreateOrder(body.plan_id, body.payment_type);
        return { order, pay_url: mockPayUrl(order.id) };
      }
      return postCreateOrder(body);
    },
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
  // mock 模式下订阅内存状态机变更，自动重拉 cache（比单纯 refetchInterval 更贴真实 webhook 到达体验）
  useSubscribeMockOrderChanges(orderId);

  return useQuery<GetPaymentOrderData>({
    queryKey: orderId ? paymentKeys.order(orderId) : paymentKeys.orders(),
    enabled: !!orderId,
    queryFn: async () => {
      if (!orderId) throw new Error('order id is required');
      if (USE_MOCK) {
        const order = mockGetOrder(orderId);
        if (!order) throw new Error('order not found');
        return { order };
      }
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

function useSubscribeMockOrderChanges(orderId: string | undefined) {
  const qc = useQueryClient();
  useSyncExternalStore(
    (listener) => {
      if (!USE_MOCK || !orderId) return () => {};
      return subscribeMockPayment(() => {
        // mock 下订单从 pending 扭到 completed 时给 wallet 加分，
        // 让余额从 recharge → profile/chat 贯通（真实环境由后端扣加）
        const data = qc.getQueryData<GetPaymentOrderData>(paymentKeys.order(orderId));
        const prevStatus = data?.order.status;
        const next = mockGetOrder(orderId);
        if (next && next.status === 'completed' && prevStatus !== 'completed') {
          mockWallet.add(next.credits_amount + next.bonus_credits);
        }
        void qc.invalidateQueries({ queryKey: paymentKeys.order(orderId) });
        void qc.invalidateQueries({ queryKey: paymentKeys.orders() });
        listener();
      });
    },
    () => 0,
    () => 0
  );
}

/** 订阅 mock 钱包余额；真实环境接入后替换成 useCurrentUserQuery 之类 */
export function useMockWalletCredits(): number {
  return useSyncExternalStore(
    (cb) => {
      if (!USE_MOCK) return () => {};
      return mockWallet.subscribe(cb);
    },
    () => (USE_MOCK ? mockWallet.getCredits() : 0),
    () => 0
  );
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
      if (USE_MOCK) {
        return mockListOrders(
          statusFilter === 'all' ? undefined : statusFilter,
          pageParam,
          pageSize
        );
      }
      return fetchOrders(query);
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}
