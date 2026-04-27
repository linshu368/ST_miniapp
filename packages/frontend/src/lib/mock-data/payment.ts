// 🔴 后端替代状态：完全未取代。
//    dev 后端 routes 里没有 payment 路由，整个 payment 模块（plans/orders/webhook）
//    都还是 frontend mock 自洽。
//    要切换：后端新增 routes/payment.ts 并在 app.ts 注册路由后，从 mock-registry 里移除
//    'payment'。本文件可保留作为强制 mock 兜底。

import type { PaymentOrder, PaymentOrderStatus, PaymentPlan, PaymentType } from '@miniapp/shared';

// ==== 套餐：4 档对应参考图 6/28/98/328 ====
export const mockPaymentPlans: PaymentPlan[] = [
  {
    id: 'plan-entry-6',
    price_cents: 600,
    original_price_cents: null,
    credits_amount: 600,
    bonus_credits: 0,
    variant: 'entry',
    badge_text: null,
    sub_copy: '初次邂逅',
    highlight_text: null,
  },
  {
    id: 'plan-standard-28',
    price_cents: 2800,
    original_price_cents: 3300,
    credits_amount: 3000,
    bonus_credits: 0,
    variant: 'standard',
    badge_text: '入门首选',
    sub_copy: '沉浸式体验',
    highlight_text: null,
  },
  {
    id: 'plan-recommended-98',
    price_cents: 9800,
    original_price_cents: 11800,
    credits_amount: 9800,
    bonus_credits: 2000,
    variant: 'recommended',
    badge_text: '75% 用户的选择',
    sub_copy: '立省¥20 · 低至 0.04元/次调用',
    highlight_text: '🔥 免费送 2,000',
  },
  {
    id: 'plan-premium-328',
    price_cents: 32800,
    original_price_cents: 42800,
    credits_amount: 32800,
    bonus_credits: 10000,
    variant: 'premium',
    badge_text: '大户专享',
    sub_copy: '≈ 3600次旗舰模型 · 历史最低单价',
    highlight_text: '狂送 10,000',
  },
];

// ==== 订单历史：铺 6 条跨状态 + 跨日期，够做分组/筛选 demo ====
const NOW = Date.now();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

// 订单号仿老项目格式 TG_{userId}_{ts}_{rand}
function mockOrderNo(tsMs: number, rand = Math.random().toString(36).slice(2, 6)): string {
  return `TG_100000001_${tsMs}_${rand}`;
}

export const mockInitialOrders: PaymentOrder[] = [
  {
    id: mockOrderNo(NOW - 3_600_000 * 2, 'aa01'),
    status: 'completed',
    payment_type: 'alipay',
    amount_cents: 9800,
    credits_amount: 9800,
    bonus_credits: 2000,
    created_at: hoursAgo(2),
    expires_at: new Date(NOW - 3_600_000 * 2 + 15 * 60_000).toISOString(),
    paid_at: hoursAgo(1.95),
    provider_transaction_id: '2026042422001412341122330001',
  },
  {
    id: mockOrderNo(NOW - 86_400_000 - 3_600_000, 'bb02'),
    status: 'completed',
    payment_type: 'wxpay',
    amount_cents: 2800,
    credits_amount: 3000,
    bonus_credits: 300,
    created_at: daysAgo(1.04),
    expires_at: new Date(NOW - 86_400_000 - 3_600_000 + 15 * 60_000).toISOString(),
    paid_at: daysAgo(1.035),
    provider_transaction_id: '4200001412202604220045612289',
  },
  {
    id: mockOrderNo(NOW - 86_400_000 * 3 - 3_600_000 * 5, 'cc03'),
    status: 'expired',
    payment_type: 'alipay',
    amount_cents: 600,
    credits_amount: 600,
    bonus_credits: 0,
    created_at: daysAgo(3.21),
    expires_at: new Date(NOW - 86_400_000 * 3 - 3_600_000 * 5 + 15 * 60_000).toISOString(),
    paid_at: null,
    provider_transaction_id: null,
  },
  {
    id: mockOrderNo(NOW - 86_400_000 * 7 - 3_600_000 * 10, 'dd04'),
    status: 'completed',
    payment_type: 'alipay',
    amount_cents: 32800,
    credits_amount: 32800,
    bonus_credits: 10000,
    created_at: daysAgo(7.42),
    expires_at: new Date(NOW - 86_400_000 * 7 - 3_600_000 * 10 + 15 * 60_000).toISOString(),
    paid_at: daysAgo(7.415),
    provider_transaction_id: '2026041622001412341122330412',
  },
  {
    id: mockOrderNo(NOW - 86_400_000 * 12, 'ee05'),
    status: 'failed',
    payment_type: 'wxpay',
    amount_cents: 2800,
    credits_amount: 3000,
    bonus_credits: 300,
    created_at: daysAgo(12),
    expires_at: new Date(NOW - 86_400_000 * 12 + 15 * 60_000).toISOString(),
    paid_at: null,
    provider_transaction_id: null,
  },
  {
    id: mockOrderNo(NOW - 86_400_000 * 21, 'ff06'),
    status: 'completed',
    payment_type: 'wxpay',
    amount_cents: 9800,
    credits_amount: 9800,
    bonus_credits: 2000,
    created_at: daysAgo(21),
    expires_at: new Date(NOW - 86_400_000 * 21 + 15 * 60_000).toISOString(),
    paid_at: daysAgo(20.998),
    provider_transaction_id: '4200001412202604030000867791',
  },
];

// ==== 内存状态机（参考 chat.ts 模式）====
// 模块作用域持久，SPA 运行期有效，刷新重置（可接受）。
// createOrder 写入 pending，5s 后自动扭为 completed，让 UI 能跑通状态轮询。

type Listener = () => void;

type MockState = {
  orders: PaymentOrder[];
};

const state: MockState = {
  orders: [...mockInitialOrders],
};

const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((l) => l());
}

function notifyOrderChanged(orderId: string) {
  // 目前所有监听器是统一订阅，直接触发；orderId 保留给将来精细化订阅用
  void orderId;
  emit();
}

export function subscribeMockPayment(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function genOrderId(): string {
  const ts = Date.now();
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 4)
      : Math.random().toString(36).slice(2, 6);
  return mockOrderNo(ts, rand);
}

function genProviderTxId(): string {
  // 模拟支付宝 28 位流水
  const base = Date.now().toString().slice(-10);
  const rand = Math.random().toString().slice(2, 20).padEnd(18, '0');
  return base + rand;
}

export function mockCreateOrder(planId: string, paymentType: PaymentType): PaymentOrder {
  const plan = mockPaymentPlans.find((p) => p.id === planId);
  if (!plan) throw new Error(`mock: unknown plan ${planId}`);

  const now = Date.now();
  const order: PaymentOrder = {
    id: genOrderId(),
    status: 'pending',
    payment_type: paymentType,
    amount_cents: plan.price_cents,
    credits_amount: plan.credits_amount,
    bonus_credits: plan.bonus_credits,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 15 * 60_000).toISOString(),
    paid_at: null,
    provider_transaction_id: null,
  };

  state.orders = [order, ...state.orders];
  emit();

  // 5s 后扭为 completed，模拟回调到达
  setTimeout(() => {
    const idx = state.orders.findIndex((o) => o.id === order.id);
    if (idx < 0) return;
    const current = state.orders[idx];
    if (!current || current.status !== 'pending') return;
    const updated: PaymentOrder = {
      ...current,
      status: 'completed',
      paid_at: new Date().toISOString(),
      provider_transaction_id: genProviderTxId(),
    };
    state.orders = [...state.orders.slice(0, idx), updated, ...state.orders.slice(idx + 1)];
    notifyOrderChanged(order.id);
  }, 5_000);

  return order;
}

export function mockGetOrder(orderId: string): PaymentOrder | undefined {
  // 惰性过期：pending 订单到 expires_at 自动扭 expired（模拟老项目定时扫）
  const idx = state.orders.findIndex((o) => o.id === orderId);
  if (idx < 0) return undefined;
  const order = state.orders[idx];
  if (!order) return undefined;
  if (order.status === 'pending' && Date.now() > Date.parse(order.expires_at)) {
    const expired: PaymentOrder = { ...order, status: 'expired' };
    state.orders = [...state.orders.slice(0, idx), expired, ...state.orders.slice(idx + 1)];
    emit();
    return expired;
  }
  return order;
}

export function mockListOrders(
  statusFilter: PaymentOrderStatus | undefined,
  cursor: string | undefined,
  limit: number
): { items: PaymentOrder[]; next_cursor: string | null } {
  // 按 created_at 倒序；cursor 就是上一页最后一条的 id
  const sorted = [...state.orders].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
  );
  const filtered = statusFilter ? sorted.filter((o) => o.status === statusFilter) : sorted;
  const startIdx = cursor ? filtered.findIndex((o) => o.id === cursor) + 1 : 0;
  const page = filtered.slice(startIdx, startIdx + limit);
  const lastItem = page.at(-1);
  const next_cursor =
    lastItem !== undefined && startIdx + limit < filtered.length ? lastItem.id : null;
  return { items: page, next_cursor };
}

/** mock 环境下的假支付链接，打开是一个能"假装付款"的静态说明页；点击也可直接留在 app 里 */
export function mockPayUrl(orderId: string): string {
  return `https://example.com/mock-pay?order=${encodeURIComponent(orderId)}`;
}
