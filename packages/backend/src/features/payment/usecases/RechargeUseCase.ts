import { EpayPaymentGateway } from '../../../infrastructure/payment/EpayPaymentGateway.js';
import { createEpayOrderId } from '../../../infrastructure/payment/epay-protocol.js';
import { config } from '../../../platform/config.js';
import {
  findPaymentPlan,
  formatAmountCny,
  ORDER_EXPIRE_MS,
  resolvePaymentProduct,
} from '../domain/rechargeRules.js';
import { readVipStrategy } from '../../../platform/vip-strategy.js';
import {
  type PaymentGateway,
  type PaymentGatewayErrorClass,
} from '../../../infrastructure/payment/PaymentGateway.js';
import {
  MiniappPaymentOrderRepository,
  toPaymentOrder,
  type MiniappPaymentOrderRow,
} from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { CreatePaymentOrderData, PaymentOrder, PaymentType } from '@miniapp/shared';
import { createLogger } from '../../../lib/logger.js';
import type { SettlementLogger } from './PaymentSettlement.js';
import {
  recordPaymentOperationEvent,
  type PaymentEventRecorder,
} from './PaymentOperationEvents.js';

type RechargeOrders = Pick<
  MiniappPaymentOrderRepository,
  'create' | 'markFailed' | 'attachProviderTransaction' | 'findByIdForUser'
>;

export class RechargeUseCase {
  private readonly events: PaymentEventRecorder | undefined;

  constructor(
    private readonly orders: RechargeOrders = new MiniappPaymentOrderRepository(),
    private readonly gateway: PaymentGateway = new EpayPaymentGateway(),
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
    const orderId = createEpayOrderId();
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
      vip_bonus_main_credits: product.vip_bonus_main_credits ?? 0,
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
      clientIp: input.clientIp,
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
      await this.failOrder(
        row,
        log,
        gatewayStartedAt,
        result.errorClass ?? 'response_invalid',
        result.outcomeUnknown === true || result.success
      );
      throw new Error(result.errorMessage || '创建支付订单失败');
    }

    // Persist before exposing checkout; unknown persistence outcomes remain recoverable by merchant ID.
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
      await this.failOrder(row, log, gatewayStartedAt, 'provider_ref_persist_failed', true);
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
    const row = await this.orders.findByIdForUser(orderId, userId);
    return row ? toPaymentOrder(row) : null;
  }

  private async failOrder(
    row: MiniappPaymentOrderRow,
    log: SettlementLogger,
    gatewayStartedAt: number,
    errorClass: PaymentGatewayErrorClass | 'provider_ref_persist_failed',
    outcomeUnknown = false
  ): Promise<void> {
    if (!outcomeUnknown) await this.orders.markFailed(row.id);
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
  }
}
