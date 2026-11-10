import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
import { config } from '../platform/config.js';
import { ok, fail } from '@miniapp/shared';
import { requestLogger } from '../lib/logger.js';
import type {
  CreatePaymentOrderRequest,
  GetPaymentOrderData,
  GetPaymentOrdersData,
  GetPaymentOrdersQuery,
  GetPaymentPlansData,
  PaymentOrderStatus,
  PaymentType,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import {
  buildVipPlans,
  getPaymentPageRuntimeConfig,
  PaymentPlansConfigError,
} from '../features/payment/domain/rechargeRules.js';
import { readVipStrategy } from '../platform/vip-strategy.js';
import { RechargeUseCase } from '../features/payment/usecases/RechargeUseCase.js';
import { reconcileWithGateway } from '../features/payment/usecases/PaymentSettlement.js';
import {
  MiniappPaymentOrderRepository,
  toPaymentOrder,
} from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { EpayPaymentGateway } from '../infrastructure/payment/EpayPaymentGateway.js';
import { registerPaymentCallbacks } from './payment-callbacks.js';

const PAYMENT_STATUSES: PaymentOrderStatus[] = ['pending', 'completed', 'expired', 'failed'];
const PAYMENT_TYPES: PaymentType[] = ['alipay', 'wxpay'];

/** Railway public HTTP ingress supplies X-Real-IP; never infer a fixed XFF hop count. */
export function paymentClientIp(
  request: Pick<FastifyRequest, 'headers' | 'ip'>,
  trustRailwayEdge = config.payment.trustRailwayEdge
): string {
  if (!trustRailwayEdge) return request.ip;
  const value = request.headers['x-real-ip'];
  // Fail closed on a missing/malformed edge header; do not substitute a proxy address.
  return typeof value === 'string' && isIP(value) ? value : '';
}

export default async function paymentRoutes(app: FastifyInstance) {
  const orders = new MiniappPaymentOrderRepository();
  const gateway = new EpayPaymentGateway();
  const recharge = new RechargeUseCase(orders, gateway, orders);
  registerPlans(app);
  registerCreate(app, recharge);
  registerOrderDetail(app, orders, gateway, recharge);
  registerOrderList(app, orders);
  registerPaymentCallbacks(app, { orders, gateway });
}

function registerPlans(app: FastifyInstance) {
  // @frontend-ready: true
  app.get('/api/payment/plans', async (request, reply) => {
    try {
      const [pageRuntime, strategy] = await Promise.all([
        getPaymentPageRuntimeConfig(),
        readVipStrategy(),
      ]);
      return reply.send(
        ok<GetPaymentPlansData>({
          plans: pageRuntime.plans,
          payment_channels: pageRuntime.paymentChannels,
          vip_plans: buildVipPlans(strategy.purchaseEnabled, strategy.plans),
          insufficient_credits_notice: pageRuntime.insufficientCreditsNotice,
        })
      );
    } catch (error) {
      requestLogger(request.log, 'payment').sys.error(
        { event: 'recharge.plans.unavailable', err: error },
        '充值套餐不可用'
      );
      return reply
        .status(503)
        .send(fail('PAYMENT_PLANS_UNAVAILABLE', '充值套餐暂不可用，请稍后重试'));
    }
  });
}

function registerCreate(app: FastifyInstance, recharge: RechargeUseCase) {
  // @frontend-ready: true
  app.post('/api/payment/orders', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const body = request.body as Partial<CreatePaymentOrderRequest>;
    if (!body.plan_id || !isPaymentType(body.payment_type)) {
      return reply.status(400).send(fail('BAD_REQUEST', 'Invalid payment order request'));
    }

    const log = requestLogger(request.log, 'payment');
    const startedAt = Date.now();
    try {
      const dbUser = await getOrCreateDbUser(request.user);
      const data = await recharge.createOrder({
        userId: dbUser.id,
        planId: body.plan_id,
        paymentType: body.payment_type,
        log,
        clientIp: paymentClientIp(request),
      });
      log.biz.info(
        {
          event: 'recharge.order.create',
          userId: dbUser.id,
          orderId: data.order.id,
          planId: body.plan_id,
          productType: data.order.product_type,
          paymentType: body.payment_type,
          providerTransactionId: data.order.provider_transaction_id,
          payUrlHost: describeUrlHost(data.pay_url),
          durationMs: Date.now() - startedAt,
        },
        '用户创建充值订单'
      );
      return reply.send(ok(data));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Create payment order failed';
      log.sys.warn(
        {
          event: 'recharge.order.create_failed',
          err: error,
          planId: body.plan_id,
          durationMs: Date.now() - startedAt,
        },
        '创建充值订单失败'
      );
      if (error instanceof PaymentPlansConfigError) {
        return reply
          .status(503)
          .send(fail('PAYMENT_PLANS_UNAVAILABLE', '充值套餐暂不可用，请稍后重试'));
      }
      return reply.status(400).send(fail('PAYMENT_CREATE_FAILED', message));
    }
  });
}

function registerOrderDetail(
  app: FastifyInstance,
  orders: MiniappPaymentOrderRepository,
  gateway: EpayPaymentGateway,
  recharge: RechargeUseCase
) {
  // @frontend-ready: true
  app.get(
    '/api/payment/orders/:id',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const { id } = request.params as { id: string };
      const dbUser = await getOrCreateDbUser(request.user);
      let order = await recharge.getOrderForUser(id, dbUser.id);

      if (!order) {
        return reply.status(404).send(fail('NOT_FOUND', 'Payment order not found'));
      }

      // 前端本来就在轮询这个接口，顺手查一次平台单据，到账不必等 Webhook。
      if (
        gateway.configured &&
        (await reconcileWithGateway(
          order,
          gateway,
          orders,
          requestLogger(request.log, 'payment'),
          'query',
          orders
        ))
      ) {
        order = (await recharge.getOrderForUser(id, dbUser.id)) ?? order;
      }

      return reply.send(ok<GetPaymentOrderData>({ order }));
    }
  );
}

function registerOrderList(app: FastifyInstance, orders: MiniappPaymentOrderRepository) {
  // @frontend-ready: true
  app.get('/api/payment/orders', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const query = request.query as GetPaymentOrdersQuery;
    const status =
      query.status && PAYMENT_STATUSES.includes(query.status) ? query.status : undefined;
    const limit = clampLimit(query.limit);
    const dbUser = await getOrCreateDbUser(request.user);
    const rows = await orders.listByUser({
      userId: dbUser.id,
      status,
      cursor: query.cursor,
      limit: limit + 1,
    });

    const visibleRows = rows.slice(0, limit);
    const nextRow = rows.length > limit ? rows[limit] : undefined;

    return reply.send(
      ok<GetPaymentOrdersData>({
        items: visibleRows.map(toPaymentOrder),
        next_cursor: nextRow?.created_at ?? null,
      })
    );
  });
}

function isPaymentType(value: unknown): value is PaymentType {
  return typeof value === 'string' && PAYMENT_TYPES.includes(value as PaymentType);
}

function clampLimit(limit: unknown): number {
  const parsed = typeof limit === 'string' ? Number.parseInt(limit, 10) : Number(limit);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(Math.max(parsed, 1), 50);
}

function describeUrlHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return 'invalid';
  }
}
