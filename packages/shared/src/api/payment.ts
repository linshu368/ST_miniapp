// 支付领域的前后端共享契约（单一真相源）
// 规则：任何一方新增对外数据形状都必须先落这里才能被消费。
// 语义与老 Bot 项目 payment_orders 保持一致，仅重新包装为 REST + snake_case。

export type PaymentType = 'alipay' | 'wxpay';

/** 与老 Bot 后端 payment_orders.payment_status 保持一致：pending → completed / expired / failed */
export type PaymentOrderStatus = 'pending' | 'completed' | 'expired' | 'failed';

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
  /** 渠道流水号（JLPay trade_no），completed 后有值 */
  provider_transaction_id: string | null;
}

// ==== GET /api/payment/plans ====
export interface GetPaymentPlansData {
  plans: PaymentPlan[];
}

// ==== POST /api/payment/orders ====
export interface CreatePaymentOrderRequest {
  plan_id: string;
  payment_type: PaymentType;
}
export interface CreatePaymentOrderData {
  order: PaymentOrder;
  /** JLPay 返回的 H5 支付链接 */
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
