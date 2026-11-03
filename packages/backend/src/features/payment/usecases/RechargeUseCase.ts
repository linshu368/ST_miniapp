import { config } from '../../../platform/config.js';
import {
  findPaymentPlan,
  formatAmountCny,
  generateMiniappOrderId,
  ORDER_EXPIRE_MS,
  PaymentPlansConfigError,
  resolvePaymentProduct,
} from '../domain/rechargeRules.js';
import { readVipStrategy } from '../../../platform/vip-strategy.js';
import {
  VexutopiaPaymentGateway,
  type PaymentGateway,
  type PaymentGatewayErrorClass,
} from '../../../infrastructure/payment/VexutopiaPaymentGateway.js';
import {
  MiniappPaymentOrderRepository,
  toPaymentOrder,
  type MiniappPaymentOrderRow,
} from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { CreatePaymentOrderData, PaymentOrder, PaymentType } from '@miniapp/shared';
import { createLogger } from '../../../lib/logger.js';
import type { SettlementLogger } from './PaymentSettlement.js';
import { observePaymentOrderFailed } from './PaymentOrderTelemetry.js';
import {
  recordPaymentOperationEvent,
  type PaymentEventRecorder,
} from './PaymentOperationEvents.js';

/** 支付宝 / 微信通道的单笔范围（¥1–1,000）。超出时供应商会拒单，提前拦下避免留一张必败的本地单。 */
const CHINA_PAY_MIN_CENTS = 100;
const CHINA_PAY_MAX_CENTS = 100_000;

type RechargeOrders = Pick<
  MiniappPaymentOrderRepository,
  | 'create'
  | 'markFailed'
  | 'attachProviderTransaction'
  | 'expirePendingByIdForUser'
  | 'findByIdForUser'
>;

export class RechargeUseCase {
  private readonly events: PaymentEventRecorder | undefined;

  constructor(
    private readonly orders: RechargeOrders = new MiniappPaymentOrderRepository(),
    private readonly gateway: PaymentGateway = new VexutopiaPaymentGateway(),
    events?: PaymentEventRecorder
  ) {
    this.events = events;
  }

  async createOrder(input: {
    userId: string;
    planId: string;
    paymentType: PaymentType;
    log?: SettlementLogger;
  }): Promise<CreatePaymentOrderData> {
    if (!config.payment.enabled) {
      throw new Error('支付功能未开启');
    }

    const strategy = await readVipStrategy();
    const product = await resolvePaymentProduct(input.planId, {
      vipPurchaseEnabled: strategy.purchaseEnabled,
      plans: strategy.plans,
      findPlan: findPaymentPlan,
    });
    if (product.amount_cents < CHINA_PAY_MIN_CENTS || product.amount_cents > CHINA_PAY_MAX_CENTS) {
      throw new PaymentPlansConfigError(
        `套餐 ${product.product_id} 金额 ${product.amount_cents} 分超出支付宝/微信单笔范围`
      );
    }

    const now = Date.now();
    const orderId = generateMiniappOrderId(input.userId);
    const row = await this.orders.create({
      id: orderId,
      user_id: input.userId,
      payment_type: input.paymentType,
      amount_cents: product.amount_cents,
      credits_amount: product.credits_amount,
      bonus_credits: product.bonus_credits,
      expires_at: new Date(now + ORDER_EXPIRE_MS).toISOString(),
      product_type: product.product_type,
      product_id: product.product_id,
      vip_duration_days: product.vip_duration_days,
      vip_bonus_credits: product.vip_bonus_credits,
    });

    const log = input.log ?? createLogger('payment');
    recordPaymentOperationEvent(this.events, log, {
      event_key: `order_creation:${row.id}`,
      order_id: row.id,
      user_id: row.user_id,
      event_kind: 'order_creation',
      stage: 'order',
      outcome: 'succeeded',
      source: 'backend',
      trigger: 'create_order',
      occurred_at: new Date().toISOString(),
    });

    const gatewayStartedAt = Date.now();
    const result = await this.gateway.createPayment({
      orderId,
      type: input.paymentType,
      amount: formatAmountCny(product.amount_cents),
      // 收银台商品名由服务端产品快照决定，避免前端改名影响渠道受理或历史订单语义。
      description: product.gateway_product_name,
    });

    if (!result.success || !result.paymentUrl || !result.providerTransactionId) {
      log.sys.warn(
        {
          event: 'payment.gateway.create_failed',
          orderId: row.id,
          errorClass: result.errorClass,
          providerCode: result.providerCode,
          durationMs: Date.now() - gatewayStartedAt,
        },
        '支付平台建单失败'
      );
      await this.failOrder(row, log, gatewayStartedAt, result.errorClass ?? 'response_invalid');
      throw new Error(result.errorMessage || '创建支付订单失败');
    }

    // 没有交易号的订单只能等 Webhook，查单兜底全部失效；宁可让用户重下一单，
    // 也不交出这样的收银台。供应商侧那笔未付款交易 30 分钟后自行过期。
    let attached = false;
    try {
      attached = await this.orders.attachProviderTransaction(orderId, result.providerTransactionId);
    } catch (error) {
      log.sys.error(
        { event: 'payment.provider_ref.persist_failed', orderId, err: error },
        '记录支付平台单号失败'
      );
    }
    if (!attached) {
      await this.failOrder(row, log, gatewayStartedAt, 'provider_ref_persist_failed');
      throw new Error('创建支付订单失败，请稍后重试');
    }

    recordPaymentOperationEvent(this.events, log, {
      event_key: `gateway_create:${row.id}`,
      order_id: row.id,
      user_id: row.user_id,
      event_kind: 'gateway_create',
      stage: 'gateway',
      outcome: 'succeeded',
      source: 'gateway',
      trigger: 'create_order',
      duration_ms: Date.now() - gatewayStartedAt,
      occurred_at: new Date().toISOString(),
    });

    return {
      order: toPaymentOrder({ ...row, provider_transaction_id: result.providerTransactionId }),
      pay_url: result.paymentUrl,
    };
  }

  async getOrderForUser(orderId: string, userId: string): Promise<PaymentOrder | null> {
    await this.orders.expirePendingByIdForUser(orderId, userId);
    const row = await this.orders.findByIdForUser(orderId, userId);
    return row ? toPaymentOrder(row) : null;
  }

  private async failOrder(
    row: MiniappPaymentOrderRow,
    log: SettlementLogger,
    gatewayStartedAt: number,
    errorClass: PaymentGatewayErrorClass | 'provider_ref_persist_failed'
  ): Promise<void> {
    await this.orders.markFailed(row.id);
    recordPaymentOperationEvent(this.events, log, {
      event_key: `gateway_create:${row.id}`,
      order_id: row.id,
      user_id: row.user_id,
      event_kind: 'gateway_create',
      stage: 'gateway',
      outcome: 'failed',
      source: 'gateway',
      trigger: 'create_order',
      error_class: errorClass,
      duration_ms: Date.now() - gatewayStartedAt,
      occurred_at: new Date().toISOString(),
    });
    try {
      void observePaymentOrderFailed(
        {
          orderId: row.id,
          userId: row.user_id,
          paymentType: row.payment_type,
          settledBy: row.settled_by,
        },
        log
      );
    } catch (telemetryError) {
      log.sys.error(
        { event: 'payment.telemetry.failed', err: telemetryError, orderId: row.id },
        '支付终态事件发送失败'
      );
    }
  }
}
