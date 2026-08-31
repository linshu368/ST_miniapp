import { FastifyInstance, FastifyReply } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import { requestLogger, type RequestLogger } from '../lib/logger.js';
import type {
  CreatePaymentOrderRequest,
  GetPaymentOrderData,
  GetPaymentOrdersData,
  GetPaymentOrdersQuery,
  GetPaymentPlansData,
  PaymentOrder,
  PaymentOrderStatus,
  PaymentType,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import {
  getInsufficientCreditsNotice,
  getPaymentPlans,
  getPaymentPromptDialogConfig,
  getRechargePageConfig,
  PaymentPlansConfigError,
} from '../features/payment/domain/rechargeRules.js';
import { RechargeUseCase } from '../features/payment/usecases/RechargeUseCase.js';
import {
  reconcileWithGateway,
  settlePaidOrder,
} from '../features/payment/usecases/PaymentSettlement.js';
import {
  MiniappPaymentOrderRepository,
  toPaymentOrder,
} from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import {
  ZqPaymentGateway,
  type ZqPaymentNotifyData,
} from '../infrastructure/payment/ZqPaymentGateway.js';
import { config } from '../platform/config.js';
import { insertUserNotification } from '../lib/notifications.js';

const PAYMENT_STATUSES: PaymentOrderStatus[] = ['pending', 'completed', 'expired', 'failed'];
const PAYMENT_TYPES: PaymentType[] = ['alipay', 'wxpay'];

export default async function paymentRoutes(app: FastifyInstance) {
  // 厂商异步通知可能以表单 POST 送达，Fastify 默认只解析 json / text。
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
  const gateway = new ZqPaymentGateway();

  // @frontend-ready: true
  app.get('/api/payment/plans', async (request, reply) => {
    try {
      const [plans, insufficientCreditsNotice, pageConfig, paymentPromptDialogConfig] =
        await Promise.all([
          getPaymentPlans(),
          getInsufficientCreditsNotice(),
          getRechargePageConfig(),
          getPaymentPromptDialogConfig(),
        ]);
      return reply.send(
        ok<GetPaymentPlansData>({
          plans,
          page_config: pageConfig,
          payment_prompt_dialog_config: paymentPromptDialogConfig,
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
          // 记下交给厂商的回调地址和收银台域名：星尘不到账时第一个要排除的就是
          // 「我们报给厂商的 notify_url 到底是哪个环境」。
          notifyUrl: config.payment.notifyUrl,
          payUrlHost: describeUrlHost(data.pay_url),
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
      let order = await recharge.getOrderForUser(id, dbUser.id);

      if (!order) {
        return reply.status(404).send(fail('NOT_FOUND', 'Payment order not found'));
      }

      // 主动查单：厂商的异步通知不保证送达，前端本来就在轮询这个接口，
      // 在这里补一次查单，到账就不再依赖对方推送。
      if (
        config.payment.enabled &&
        (await reconcileWithGateway(order, gateway, orders, requestLogger(request.log, 'payment')))
      ) {
        order = (await recharge.getOrderForUser(id, dbUser.id)) ?? order;
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

  // @frontend-ready: true
  app.get('/api/payment/return', async (request, reply) => {
    const log = requestLogger(request.log, 'payment');
    const returnData = normalizeNotifyData(request.query);
    const verification = verifyNotify(gateway, returnData);
    const orderId =
      verification.ok && isSafePaymentOrderId(verification.orderId) ? verification.orderId : null;

    // 厂商《支付结果通知》把 notify_url 和 return_url 都定义为「支付结果通知」，
    // 参数与签名完全相同。异步通知不保证送达（实测就有整条没推的订单），所以验签通过的
    // 同步回跳同样入账；重复入账由 credits_added 幂等兜住。
    if (orderId && returnData.trade_status === 'TRADE_SUCCESS') {
      await settlePaidOrder(
        {
          orderId,
          paidAmount: returnData.money,
          providerTransactionId: returnData.trade_no ?? null,
        },
        orders,
        log,
        'return'
      ).catch((error: unknown) => {
        // 回跳的首要职责是把用户送回 MiniApp，入账失败不能卡住导航。
        log.sys.error(
          { event: 'payment.return.settle_failed', orderId, err: error },
          '同步回跳入账失败'
        );
      });
    } else if (!verification.ok) {
      log.sys.warn(
        {
          event: 'payment.return.verify_failed',
          reason: verification.reason,
          fields: Object.keys(returnData).sort(),
        },
        '同步回跳验证失败，仅做导航'
      );
    }

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

  // @frontend-ready: true
  app.get('/api/payment/webhook/zqpay', async (request, reply) => {
    return handleZqPayWebhook(
      request.query,
      reply,
      gateway,
      orders,
      requestLogger(request.log, 'payment')
    );
  });

  // @frontend-ready: true
  app.post('/api/payment/webhook/zqpay', async (request, reply) => {
    return handleZqPayWebhook(
      request.body,
      reply,
      gateway,
      orders,
      requestLogger(request.log, 'payment')
    );
  });
}

type WebhookVerification =
  | { ok: true; orderId: string }
  | {
      ok: false;
      reason: 'missing_order_id' | 'merchant_mismatch' | 'invalid_signature' | 'stale_timestamp';
    };

function verifyNotify(
  gateway: Pick<ZqPaymentGateway, 'isExpectedMerchant' | 'verifyNotifySign'>,
  notifyData: ZqPaymentNotifyData
): WebhookVerification {
  const orderId = notifyData.out_trade_no;
  if (!orderId) return { ok: false, reason: 'missing_order_id' };
  if (!gateway.isExpectedMerchant(notifyData.pid)) {
    return { ok: false, reason: 'merchant_mismatch' };
  }
  if (!gateway.verifyNotifySign(notifyData)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  // timestamp 只在厂商真的带了的时候校验：子千易实测会省略这个字段，把它当必填
  // 会连同合法回调一起判死。防重放由 RSA 验签和 credits_added 幂等承担。
  if (notifyData.timestamp && !isRecentTimestamp(notifyData.timestamp)) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  return { ok: true, orderId };
}

export async function handleZqPayWebhook(
  payload: unknown,
  reply: FastifyReply,
  gateway: Pick<ZqPaymentGateway, 'isExpectedMerchant' | 'verifyNotifySign'>,
  orders: Pick<MiniappPaymentOrderRepository, 'findById' | 'complete' | 'reopenExpired'>,
  log: RequestLogger
) {
  const notifyData = normalizeNotifyData(payload);
  const verification = verifyNotify(gateway, notifyData);

  if (!verification.ok) {
    log.sys.warn(
      {
        event: 'payment.webhook.verify_failed',
        reason: verification.reason,
        orderId: notifyData.out_trade_no,
        pid: notifyData.pid,
        // 只记字段名不记值：定位「厂商到底发了什么」时不泄露签名和金额。
        fields: Object.keys(notifyData).sort(),
      },
      '子千易支付回调验证失败'
    );
    return reply.status(400).type('text/plain').send('fail');
  }

  const orderId = verification.orderId;
  log.biz.info({ event: 'payment.webhook.received', orderId }, '收到子千易支付回调');

  if (notifyData.trade_status !== 'TRADE_SUCCESS') {
    return reply.type('text/plain').send('success');
  }

  const settlement = await settlePaidOrder(
    { orderId, paidAmount: notifyData.money, providerTransactionId: notifyData.trade_no ?? null },
    orders,
    log,
    'webhook'
  );

  switch (settlement) {
    case 'completed':
      return reply.type('text/plain').send('success');
    case 'order_not_found':
      return reply.status(404).type('text/plain').send('fail');
    case 'amount_mismatch':
      return reply.status(400).type('text/plain').send('fail');
    default:
      return reply.status(500).type('text/plain').send('fail');
  }
}

function normalizeNotifyData(payload: unknown): ZqPaymentNotifyData {
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

function isRecentTimestamp(value: string | undefined): boolean {
  if (!value || !/^\d{10}$/.test(value)) return false;
  const timestampMs = Number(value) * 1000;
  return Number.isSafeInteger(timestampMs) && Math.abs(Date.now() - timestampMs) <= 10 * 60 * 1000;
}

function describeUrlHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return 'invalid';
  }
}

function isSafePaymentOrderId(value: string | undefined): value is string {
  return Boolean(value && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value));
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

function resolveMiniappShortName(): string {
  const value = (process.env.MINIAPP_SHORT_NAME || 'app').replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : 'app';
}
