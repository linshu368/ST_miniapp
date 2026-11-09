// 支付领域的前后端共享契约（单一真相源）
// 规则：任何一方新增对外数据形状都必须先落这里才能被消费。
// 语义与老 Bot 项目 payment_orders 保持一致，仅重新包装为 REST + snake_case。

import { z } from 'zod';

import { isVipPlanId, type VipPlan } from './vip.js';

export type PaymentType = 'alipay' | 'wxpay';
export const PaymentTypeSchema = z.enum(['alipay', 'wxpay']);

/** TTZF 易支付 GET 通知的外部契约；签名覆盖扩展字段，由后端使用原始 query 验证。 */
export const EpayNotificationSchema = z
  .object({
    pid: z.string().regex(/^\d{1,20}$/),
    trade_no: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    out_trade_no: z.string().regex(/^EP[0-9a-f]{30}$/),
    type: PaymentTypeSchema,
    name: z.string().min(1).max(2_048),
    money: z.string().regex(/^\d{1,12}(?:\.\d{1,3})?$/),
    trade_status: z.enum(['TRADE_PENDING', 'TRADE_SUCCESS', 'TRADE_REFUND', 'TRADE_ERROR']),
    param: z.string().min(1).max(120),
    sign: z.string().regex(/^[a-fA-F0-9]{32}$/),
    sign_type: z.literal('MD5'),
  })
  .catchall(z.string().max(2_048));
export type EpayNotification = z.infer<typeof EpayNotificationSchema>;

/** Provider responses are validated before any checkout or settlement is exposed. */
export const EpayCreateResponseSchema = z.object({
  code: z.literal(1),
  trade_no: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  payurl: z.string().url().max(4_096),
});

export const EpayQueryResponseSchema = z.object({
  code: z.literal(1),
  pid: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative().safe()]),
  trade_no: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  out_trade_no: z.string().regex(/^EP[0-9a-f]{30}$/),
  type: PaymentTypeSchema,
  money: z.string().regex(/^\d{1,12}(?:\.\d{1,3})?$/),
  status: z.union([z.literal(0), z.literal(1)]),
  param: z.string().min(1).max(120),
});

/**
 * Controls which checkout entries are presented to new purchasers. It deliberately does not
 * change gateway support: pending and historic orders continue to use their stored payment type.
 */
export interface PaymentChannelsConfig {
  alipay_enabled: boolean;
  wxpay_enabled: boolean;
  default_payment_type: PaymentType;
}

export const DEFAULT_PAYMENT_CHANNELS_CONFIG: PaymentChannelsConfig = {
  alipay_enabled: true,
  wxpay_enabled: false,
  default_payment_type: 'alipay',
};

export const PaymentChannelsConfigSchema: z.ZodType<PaymentChannelsConfig> = z
  .object({
    alipay_enabled: z.boolean(),
    wxpay_enabled: z.boolean(),
    default_payment_type: PaymentTypeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.alipay_enabled && !value.wxpay_enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one payment channel must be enabled',
      });
    }
    if (
      (value.default_payment_type === 'alipay' && !value.alipay_enabled) ||
      (value.default_payment_type === 'wxpay' && !value.wxpay_enabled)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default_payment_type'],
        message: 'default payment channel must be enabled',
      });
    }
  });

/** 与老 Bot 后端 payment_orders.payment_status 保持一致：pending → completed / expired / failed */
export type PaymentOrderStatus = 'pending' | 'completed' | 'expired' | 'failed';
export const PaymentOrderStatusSchema = z.enum(['pending', 'completed', 'expired', 'failed']);

/**
 * 入账路径。四条路径共用同一条结算逻辑，谁先确认支付由谁入账。
 * 取值同时用于日志 `source` 字段和 `payment_orders.settled_by` 列，不能各自定义。
 */
export type PaymentSettlementSource = 'webhook' | 'return' | 'query' | 'cron';
export const PaymentSettlementSourceSchema = z.enum(['webhook', 'return', 'query', 'cron']);

export type PaymentProductType = 'credits' | 'vip';
export const PaymentProductTypeSchema = z.enum(['credits', 'vip']);

/** 套餐视觉变体，驱动 4 档层级样式（entry 降权 / standard / recommended 主推 / premium 大户） */
export type PaymentPlanVariant = 'entry' | 'standard' | 'recommended' | 'premium';

export interface PaymentPlan {
  /** 服务端约定稳定 key，前端作 react key / 埋点 */
  id: string;
  /** 实付价（人民币分）。前端展示时 / 100 */
  price_cents: number;
  /** 划价原价（分）；无活动时 null，前端不渲染删除线 */
  original_price_cents: number | null;
  /** 主积分（星尘） */
  credits_amount: number;
  /** 赠送积分；无赠送为 0。"+N%赠送" 与 "免费送 N" 由前端据此派生 */
  bonus_credits: number;
  /** 视觉变体 */
  variant: PaymentPlanVariant;
  /** 头部 / 角标徽章文案，服务端运行时配置。如"入门首选""75% 用户的选择""大户专享" */
  badge_text: string | null;
  /** 副标文案，服务端可配。如"沉浸式体验""≈ 3600次旗舰模型" */
  sub_copy: string | null;
  /** 高亮行文案，服务端可配。如"🔥 免费送 2,000""狂送 10,000" */
  highlight_text: string | null;
}

const nonnegativeInteger = z.number().int().nonnegative();
const nullableText = z.string().nullable();

export const PaymentPlanSchema: z.ZodType<PaymentPlan> = z.object({
  id: z.string().trim().min(1),
  price_cents: nonnegativeInteger,
  original_price_cents: nonnegativeInteger.nullable(),
  credits_amount: nonnegativeInteger,
  bonus_credits: nonnegativeInteger,
  variant: z.enum(['entry', 'standard', 'recommended', 'premium']),
  badge_text: nullableText,
  sub_copy: nullableText,
  highlight_text: nullableText,
});

export const PaymentPlansSchema = z
  .array(PaymentPlanSchema)
  .min(1)
  .superRefine((plans, ctx) => {
    const ids = plans.map((plan) => plan.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'payment plan ids must be unique',
      });
    }
  });

/** The published runtime shape. The legacy array remains readable during staged deployment. */
export interface PaymentPlansConfig {
  plans: PaymentPlan[];
  payment_channels: PaymentChannelsConfig;
}

export const PaymentPlansConfigSchema: z.ZodType<PaymentPlansConfig> = z
  .object({
    plans: PaymentPlansSchema,
    payment_channels: PaymentChannelsConfigSchema,
  })
  .strict();

export const PaymentPlansRuntimeConfigSchema = z
  .union([PaymentPlansConfigSchema, PaymentPlansSchema])
  .transform(
    (value): PaymentPlansConfig =>
      Array.isArray(value)
        ? { plans: value, payment_channels: DEFAULT_PAYMENT_CHANNELS_CONFIG }
        : value
  );

export const DEFAULT_PENDING_ARRIVAL_HINT = '完成付款后积分将自动到账，通常不超过 3 分钟';

/**
 * 星尘商店展示参数。曾由运营平台配置，现固定在代码里，不再提供运营入口。
 * 颜色是新皮肤下的实际取值。
 */
export const RECHARGE_PAGE_DISPLAY = {
  buttonText: '立即支付',
  balanceColor: '#8b5cf6',
  selectedPlanColor: '#d0b99a',
  badgeColor: '#d0b99a',
  buttonColor: '#ead7bc',
  pendingArrivalHint: DEFAULT_PENDING_ARRIVAL_HINT,
} as const;

export interface PaymentOrder {
  /** 订单号，沿用老项目 TG_{userId}_{ts}_{rand} 语义 */
  id: string;
  status: PaymentOrderStatus;
  payment_type: PaymentType;
  /** 下单金额（分） */
  amount_cents: number;
  /** 本单主积分（已到账或将到账） */
  credits_amount: number;
  /** 本单赠送积分 */
  bonus_credits: number;
  created_at: string; // ISO 8601
  /** 过期时间戳；pending 到点后本地扫会扭 expired */
  expires_at: string; // ISO 8601
  /** completed 时有值 */
  paid_at: string | null;
  /** 渠道流水号，completed 后有值 */
  provider_transaction_id: string | null;
  /**
   * 入账路径。未完成订单与 migration 103 之前的历史订单为 null。
   * 订单详情与订单列表必须使用同一映射，不得只在其中一个透出。
   */
  settled_by: PaymentSettlementSource | null;
  /**
   * Additive VIP/credits 商品快照。旧订单与旧 mapper 可以省略；
   * 新 producer 应写出 product_type / product_id，VIP 单再写时长、赠送与履约截止时间。
   */
  product_type?: PaymentProductType;
  product_id?: string | null;
  fulfillment_applied?: boolean;
  vip_duration_days?: number | null;
  vip_bonus_credits?: number | null;
  vip_bonus_main_credits?: number | null;
  vip_valid_until?: string | null;
}

// ==== GET /api/payment/plans ====
export interface GetPaymentPlansData {
  plans: PaymentPlan[];
  /** Channels visible for creating new orders; all historical order types remain displayable. */
  payment_channels?: PaymentChannelsConfig;
  /** 旧客户端忽略即可；未部署 VIP 商品的 producer 可以省略。 */
  vip_plans?: VipPlan[];
  /** 因余额不足进入充值页时展示的运营提示语 */
  insufficient_credits_notice: string;
}

// ==== POST /api/payment/orders ====
export interface CreatePaymentOrderRequest {
  plan_id: string;
  payment_type: PaymentType;
}
export interface CreatePaymentOrderData {
  order: PaymentOrder;
  /** 支付平台托管收银台地址（https） */
  pay_url: string;
}

// ==== GET /api/payment/orders/:id ====
export interface GetPaymentOrderData {
  order: PaymentOrder;
}

// ==== GET /api/payment/orders?status&cursor&limit ====
export interface GetPaymentOrdersQuery {
  /** 不传 = 全部；'pending' | 'completed' | 'expired' | 'failed' */
  status?: PaymentOrderStatus;
  /** 上一页返回的 next_cursor，首屏不传 */
  cursor?: string;
  /** 1..50，默认 20 */
  limit?: number;
}
export interface GetPaymentOrdersData {
  items: PaymentOrder[];
  /** null 代表没有下一页 */
  next_cursor: string | null;
}

export function paymentProductTypeForPlanId(planId: string): PaymentProductType | null {
  if (isVipPlanId(planId)) return 'vip';
  return null;
}
