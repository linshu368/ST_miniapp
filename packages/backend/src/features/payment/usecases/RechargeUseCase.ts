import { config } from '../../../platform/config.js';
import {
  findPaymentPlan,
  formatAmountCny,
  generateMiniappOrderId,
  ORDER_EXPIRE_MS,
} from '../domain/rechargeRules.js';
import { ZqPaymentGateway } from '../../../infrastructure/payment/ZqPaymentGateway.js';
import {
  MiniappPaymentOrderRepository,
  toPaymentOrder,
} from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { CreatePaymentOrderData, PaymentOrder, PaymentType } from '@miniapp/shared';

export class RechargeUseCase {
  constructor(
    private readonly orders = new MiniappPaymentOrderRepository(),
    private readonly gateway = new ZqPaymentGateway()
  ) {}

  async createOrder(input: {
    userId: string;
    planId: string;
    paymentType: PaymentType;
    clientIp: string;
  }): Promise<CreatePaymentOrderData> {
    if (!config.payment.enabled) {
      throw new Error('支付功能未开启');
    }

    const plan = await findPaymentPlan(input.planId);
    if (!plan) {
      throw new Error('支付套餐不存在');
    }

    const now = Date.now();
    const orderId = generateMiniappOrderId(input.userId);
    const row = await this.orders.create({
      id: orderId,
      user_id: input.userId,
      payment_type: input.paymentType,
      amount_cents: plan.price_cents,
      credits_amount: plan.credits_amount,
      bonus_credits: plan.bonus_credits,
      expires_at: new Date(now + ORDER_EXPIRE_MS).toISOString(),
    });

    const result = await this.gateway.createPayment({
      type: input.paymentType,
      outTradeNo: orderId,
      amount: formatAmountCny(plan.price_cents),
      userId: input.userId,
      productName: `星尘充值 ${plan.credits_amount + plan.bonus_credits}`,
      clientIp: input.clientIp,
    });

    if (!result.success || !result.paymentUrl) {
      await this.orders.markFailed(orderId);
      throw new Error(result.errorMessage || '创建支付订单失败');
    }

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
