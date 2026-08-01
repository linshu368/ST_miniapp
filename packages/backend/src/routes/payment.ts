import { FastifyInstance, FastifyReply } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import { requestLogger, type RequestLogger } from '../lib/logger.js';
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
  getInsufficientCreditsNotice,
  getPaymentPlans,
  getRechargePageConfig,
  PaymentPlansConfigError,
} from '../features/payment/domain/rechargeRules.js';
import { RechargeUseCase } from '../features/payment/usecases/RechargeUseCase.js';
import {
  JLPaymentGateway,
  type PaymentNotifyData,
} from '../infrastructure/payment/JLPaymentGateway.js';
import {
  MiniappPaymentOrderRepository,
  toPaymentOrder,
} from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { config } from '../platform/config.js';
import { insertUserNotification } from '../lib/notifications.js';

const PAYMENT_STATUSES: PaymentOrderStatus[] = ['pending', 'completed', 'expired', 'failed'];
// 入参白名单。产品侧当前只在充值页出支付宝，这里仍放行 wxpay，
// 避免缓存了旧前端的客户端选微信时拿到 400 而不是可用的扫码收银台。
const PAYMENT_TYPES: PaymentType[] = ['alipay', 'wxpay'];

export default async function paymentRoutes(app: FastifyInstance) {
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      }
    );
  }

  const recharge = new RechargeUseCase();
  const orders = new MiniappPaymentOrderRepository();
  const gateway = new JLPaymentGateway();

  // @frontend-ready: true
  app.get('/api/payment/plans', async (request, reply) => {
    try {
      const [plans, insufficientCreditsNotice, pageConfig] = await Promise.all([
        getPaymentPlans(),
        getInsufficientCreditsNotice(),
        getRechargePageConfig(),
      ]);
      return reply.send(
        ok<GetPaymentPlansData>({
          plans,
          page_config: pageConfig,
          insufficient_credits_notice: insufficientCreditsNotice,
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

  // @frontend-ready: true
  app.post('/api/payment/orders', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const body = request.body as Partial<CreatePaymentOrderRequest>;
    if (!body.plan_id || !isPaymentType(body.payment_type)) {
      return reply.status(400).send(fail('BAD_REQUEST', 'Invalid payment order request'));
    }

    const log = requestLogger(request.log, 'payment');
    try {
      const dbUser = await getOrCreateDbUser(request.user);
      const data = await recharge.createOrder({
        userId: dbUser.id,
        planId: body.plan_id,
        paymentType: body.payment_type,
        clientIp: request.ip,
      });
      log.biz.info(
        {
          event: 'recharge.order.create',
          userId: dbUser.id,
          orderId: data.order.id,
          planId: body.plan_id,
          paymentType: body.payment_type,
        },
        '用户创建充值订单'
      );
      return reply.send(ok(data));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Create payment order failed';
      log.sys.warn(
        { event: 'recharge.order.create_failed', err: error, planId: body.plan_id },
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

  // @frontend-ready: true
  app.get(
    '/api/payment/orders/:id',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const { id } = request.params as { id: string };
      const dbUser = await getOrCreateDbUser(request.user);
      const order = await recharge.getOrderForUser(id, dbUser.id);

      if (!order) {
        return reply.status(404).send(fail('NOT_FOUND', 'Payment order not found'));
      }

      return reply.send(ok<GetPaymentOrderData>({ order }));
    }
  );

  // @frontend-ready: true
  app.get('/api/payment/orders', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const query = request.query as GetPaymentOrdersQuery;
    const status =
      query.status && PAYMENT_STATUSES.includes(query.status) ? query.status : undefined;
    const limit = clampLimit(query.limit);
    const dbUser = await getOrCreateDbUser(request.user);
    await orders.expirePendingForUser(dbUser.id);
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

  app.get('/api/payment/return', async (request, reply) => {
    const returnData = normalizeNotifyData(request.query);
    const orderId = isSafePaymentOrderId(returnData.out_trade_no) ? returnData.out_trade_no : null;
    const botUsername = await resolveTelegramBotUsername();

    reply.header('Cache-Control', 'no-store');
    if (botUsername) {
      const startParam = orderId ? `payment_return_${orderId}` : 'payment_return';
      const miniappShortName = resolveMiniappShortName();
      const telegramUrl = new URL(`https://t.me/${botUsername}/${miniappShortName}`);
      telegramUrl.searchParams.set('startapp', startParam);
      return reply.redirect(telegramUrl.toString());
    }

    const fallbackUrl = new URL(
      orderId ? `/profile/recharge/${encodeURIComponent(orderId)}` : '/profile/orders',
      config.frontendUrl
    );
    fallbackUrl.searchParams.set('payment', 'returned');
    return reply.redirect(fallbackUrl.toString());
  });

  app.get('/api/payment/webhook/jlpay', async (request, reply) => {
    return handleJlpayWebhook(
      request.query,
      reply,
      gateway,
      orders,
      requestLogger(request.log, 'payment')
    );
  });

  app.post('/api/payment/webhook/jlpay', async (request, reply) => {
    return handleJlpayWebhook(
      request.body,
      reply,
      gateway,
      orders,
      requestLogger(request.log, 'payment')
    );
  });
}

async function handleJlpayWebhook(
  payload: unknown,
  reply: FastifyReply,
  gateway: JLPaymentGateway,
  orders: MiniappPaymentOrderRepository,
  log: RequestLogger
) {
  const notifyData = normalizeNotifyData(payload);
  if (!notifyData.out_trade_no || !gateway.verifyNotifySign(notifyData)) {
    log.sys.warn(
      { event: 'payment.webhook.sign_failed', orderId: notifyData.out_trade_no },
      'JLPay 回调验签失败'
    );
    return reply.status(400).type('text/plain').send('fail');
  }

  log.biz.info(
    { event: 'payment.webhook.received', orderId: notifyData.out_trade_no },
    '收到 JLPay 支付回调'
  );

  if (notifyData.trade_status !== 'TRADE_SUCCESS') {
    return reply.type('text/plain').send('success');
  }

  const order = await orders.findById(notifyData.out_trade_no);
  if (!order) {
    log.sys.warn(
      { event: 'payment.webhook.order_not_found', orderId: notifyData.out_trade_no },
      'JLPay 回调订单不存在'
    );
    return reply.status(404).type('text/plain').send('fail');
  }

  const paidAmountCents = parseAmountCents(notifyData.money);
  if (paidAmountCents !== order.amount_cents) {
    log.sys.warn(
      {
        event: 'payment.webhook.amount_mismatch',
        orderId: order.id,
        expected: order.amount_cents,
        actual: paidAmountCents,
      },
      'JLPay 回调金额不匹配'
    );
    return reply.status(400).type('text/plain').send('fail');
  }

  try {
    await orders.complete(order.id, notifyData.trade_no ?? null);
    if (order.status !== 'completed') {
      try {
        const totalCredits = order.credits_amount + order.bonus_credits;
        await insertUserNotification({
          userId: order.user_id,
          category: 'system',
          title: '星尘充值到账',
          body: `订单 ${order.id} 已完成，${totalCredits} 星尘已到账。`,
        });
      } catch (notificationError) {
        log.sys.error(
          { event: 'payment.notification.failed', orderId: order.id, err: notificationError },
          '支付完成消息写入失败'
        );
      }
    }
    log.biz.info(
      { event: 'payment.webhook.completed', orderId: order.id, amountCents: order.amount_cents },
      '支付订单完成'
    );
    return reply.type('text/plain').send('success');
  } catch (error) {
    log.sys.error(
      { event: 'payment.webhook.complete_failed', err: error, orderId: order.id },
      'JLPay 订单完成处理失败'
    );
    return reply.status(500).type('text/plain').send('fail');
  }
}

function normalizeNotifyData(payload: unknown): PaymentNotifyData {
  if (!payload || typeof payload !== 'object') return {};
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([key, value]) => [key, String(value)])
  );
}

function isPaymentType(value: unknown): value is PaymentType {
  return typeof value === 'string' && PAYMENT_TYPES.includes(value as PaymentType);
}

function clampLimit(limit: unknown): number {
  const parsed = typeof limit === 'string' ? Number.parseInt(limit, 10) : Number(limit);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(Math.max(parsed, 1), 50);
}

function parseAmountCents(amount: string | undefined): number {
  if (!amount) return NaN;
  return Math.round(Number.parseFloat(amount) * 100);
}

let telegramBotUsernamePromise: Promise<string | null> | null = null;

function resolveTelegramBotUsername(): Promise<string | null> {
  if (!config.telegramBotToken) return Promise.resolve(null);
  telegramBotUsernamePromise ??= fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/getMe`,
    { signal: AbortSignal.timeout(5_000) }
  )
    .then(
      (response) =>
        response.json() as Promise<{
          ok?: boolean;
          result?: { username?: string };
        }>
    )
    .then((data) => {
      const username = data.ok ? data.result?.username?.replace(/^@/, '') : null;
      return username && /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : null;
    })
    .catch(() => null);
  return telegramBotUsernamePromise;
}

function isSafePaymentOrderId(value: string | undefined): value is string {
  return Boolean(value && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value));
}

function resolveMiniappShortName(): string {
  const value = (process.env.MINIAPP_SHORT_NAME || 'app').replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : 'app';
}
