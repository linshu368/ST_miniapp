import { config } from '../../../platform/config.js';
import {
  findPaymentPlan,
  formatAmountCny,
  generateMiniappOrderId,
  ORDER_EXPIRE_MS,
  resolvePaymentProduct,
} from '../domain/rechargeRules.js';
import { readVipStrategy } from '../../../platform/vip-strategy.js';
import { ZqPaymentGateway } from '../../../infrastructure/payment/ZqPaymentGateway.js';
import {
  MiniappPaymentOrderRepository,
  toPaymentOrder,
} from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { CreatePaymentOrderData, PaymentOrder, PaymentType } from '@miniapp/shared';
import { createLogger } from '../../../lib/logger.js';
import type { SettlementLogger } from './PaymentSettlement.js';
import { observePaymentOrderFailed } from './PaymentOrderTelemetry.js';
import {
  recordPaymentOperationEvent,
  type PaymentEventRecorder,
} from './PaymentOperationEvents.js';

export class RechargeUseCase {
  private readonly events: PaymentEventRecorder | undefined;

  constructor(
    private readonly orders = new MiniappPaymentOrderRepository(),
    private readonly gateway = new ZqPaymentGateway(),
    events?: PaymentEventRecorder
  ) {
    this.events = events;
  }

  async createOrder(input: {
    userId: string;
    planId: string;
    paymentType: PaymentType;
    clientIp: string;
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
      type: input.paymentType,
      outTradeNo: orderId,
      amount: formatAmountCny(product.amount_cents),
      userId: input.userId,
      // 网关商品名由服务端产品快照决定，避免前端改名影响渠道受理或历史订单语义。
      productName: product.gateway_product_name,
      clientIp: input.clientIp,
    });

    if (!result.success || !result.paymentUrl) {
      await this.orders.markFailed(orderId);
      recordPaymentOperationEvent(this.events, log, {
        event_key: `gateway_create:${row.id}`,
        order_id: row.id,
        user_id: row.user_id,
        event_kind: 'gateway_create',
        stage: 'gateway',
        outcome: 'failed',
        source: 'gateway',
        trigger: 'create_order',
        error_class: result.errorClass ?? 'response_invalid',
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
      throw new Error(result.errorMessage || '创建支付订单失败');
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
      order: toPaymentOrder(row),
      pay_url: result.paymentUrl,
    };
  }

  async getOrderForUser(orderId: string, userId: string): Promise<PaymentOrder | null> {
    await this.orders.expirePendingByIdForUser(orderId, userId);
    const row = await this.orders.findByIdForUser(orderId, userId);
    return row ? toPaymentOrder(row) : null;
  }
}
