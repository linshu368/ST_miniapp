import { FastifyInstance } from 'fastify';
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
  buildVipPlans,
  getPaymentPageRuntimeConfig,
  PaymentPlansConfigError,
} from '../features/payment/domain/rechargeRules.js';
import { readVipStrategy } from '../platform/vip-strategy.js';
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
  METADATA_ENVIRONMENT,
  METADATA_ORDER_ID,
  VexutopiaPaymentGateway,
} from '../infrastructure/payment/VexutopiaPaymentGateway.js';
import { config } from '../platform/config.js';
import {
  recordPaymentOperationEvent,
  type PaymentEventRecorder,
} from '../features/payment/usecases/PaymentOperationEvents.js';

const PAYMENT_STATUSES: PaymentOrderStatus[] = ['pending', 'completed', 'expired', 'failed'];
const PAYMENT_TYPES: PaymentType[] = ['alipay', 'wxpay'];
export const VEXUTOPIA_SIGNATURE_HEADER = 'x-vexutopia-signature';

export default async function paymentRoutes(app: FastifyInstance) {
  const orders = new MiniappPaymentOrderRepository();
  const gateway = new VexutopiaPaymentGateway();
  const recharge = new RechargeUseCase(orders, gateway, orders);

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
          page_config: pageRuntime.pageConfig,
          payment_prompt_dialog_config: pageRuntime.paymentPromptDialogConfig,
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
        config.payment.enabled &&
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

  // 收银台付款后浏览器跳回这里。URL 参数不签名，只用来导航；入账靠一次服务端查单。
  // @frontend-ready: true
  app.get('/api/payment/return', async (request, reply) => {
    const log = requestLogger(request.log, 'payment');
    const rawOrderId = (request.query as { order_id?: unknown }).order_id;
    const orderId =
      typeof rawOrderId === 'string' && isSafePaymentOrderId(rawOrderId) ? rawOrderId : null;

    recordPaymentOperationEvent(orders, log, {
      event_key: `return:${orderId ?? 'unknown'}:${Date.now()}`,
      order_id: orderId,
      user_id: null,
      event_kind: 'return',
      stage: 'callback',
      outcome: orderId ? 'succeeded' : 'failed',
      source: 'gateway',
      trigger: 'return',
      error_class: orderId ? null : 'missing_order_id',
      occurred_at: new Date().toISOString(),
    });

    if (orderId && config.payment.enabled) {
      try {
        const order = await orders.findById(orderId);
        if (order) await reconcileWithGateway(order, gateway, orders, log, 'query', orders);
      } catch (error) {
        // 回跳的首要职责是把用户送回 MiniApp，查单失败不能卡住导航。
        log.sys.error(
          { event: 'payment.return.query_failed', orderId, err: error },
          '回跳查单失败'
        );
      }
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

  // 验签必须拿原始字节，只在这个子作用域里把 JSON 解析成 Buffer，其他路由不受影响。
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body)
    );

    // @frontend-ready: false
    scope.post('/api/payment/webhook/vexutopia', async (request, reply) => {
      const signature = request.headers[VEXUTOPIA_SIGNATURE_HEADER];
      const result = await handleVexutopiaWebhook(
        Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        typeof signature === 'string' ? signature : undefined,
        { gateway, orders, events: orders, log: requestLogger(request.log, 'payment') }
      );
      return reply.status(result.status).type('text/plain').send(result.body);
    });
  });
}

type WebhookDeps = {
  gateway: Pick<VexutopiaPaymentGateway, 'verifyWebhook' | 'environment'>;
  orders: Pick<MiniappPaymentOrderRepository, 'findById' | 'complete' | 'reopenExpired'>;
  events?: PaymentEventRecorder;
  log: RequestLogger;
};

/**
 * 返回码约定：只有“验签不过”（401/400）和“我们自己暂时失败”（500）不回 200。
 * 订单不存在、金额不符这类重投也修不好的问题回 200 止住重投，靠事件和告警暴露。
 */
export async function handleVexutopiaWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  deps: WebhookDeps
): Promise<{ status: number; body: string }> {
  const { log, events } = deps;
  const verification = deps.gateway.verifyWebhook(rawBody, signatureHeader);
  const record = (
    outcome: 'succeeded' | 'failed' | 'skipped',
    errorClass: string | null,
    orderId: string | null,
    paymentId?: string
  ) =>
    recordPaymentOperationEvent(events, log, {
      event_key: `webhook:${outcome}:${errorClass ?? 'ok'}:${orderId ?? 'none'}:${paymentId ?? 'none'}:${Date.now()}`,
      order_id: orderId,
      user_id: null,
      event_kind: 'webhook',
      stage: 'callback',
      outcome,
      source: 'gateway',
      trigger: 'webhook',
      error_class: errorClass,
      occurred_at: new Date().toISOString(),
    });

  if (!verification.ok) {
    record('failed', verification.reason, null);
    log.sys.warn(
      { event: 'payment.webhook.verify_failed', reason: verification.reason },
      'Vexutopia 回调验证失败'
    );
    return verification.reason === 'invalid_body'
      ? { status: 400, body: 'invalid body' }
      : { status: 401, body: 'unauthorized' };
  }

  const event = verification.event;
  const metadata = event.metadata ?? {};
  const rawOrderId = metadata[METADATA_ORDER_ID];
  const orderId = rawOrderId && isSafePaymentOrderId(rawOrderId) ? rawOrderId : null;
  const paymentId = event.payment_id ?? event.id;

  // 同一组织的注册端点会收到所有环境的事件；别的环境的订单不在本库，直接确认收到。
  if (metadata[METADATA_ENVIRONMENT] !== deps.gateway.environment) {
    record('skipped', 'foreign_environment', null);
    return { status: 200, body: 'ignored' };
  }

  log.biz.info(
    { event: 'payment.webhook.received', type: event.event, orderId, paymentId },
    '收到 Vexutopia 支付回调'
  );

  if (event.event === 'payment.refunded') {
    // 第一版不自动扣回权益：退款/拒付都要人工判断，告警会通知到人。
    record('failed', event.type === 'chargeback' ? 'chargeback' : 'refund', orderId, paymentId);
    log.sys.warn(
      { event: 'payment.webhook.refunded', orderId, paymentId, type: event.type },
      '平台发生退款或拒付，需人工处理权益'
    );
    return { status: 200, body: 'OK' };
  }
  if (event.event !== 'payment.completed') {
    record(
      'skipped',
      `ignored_${event.event.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 80),
      orderId,
      paymentId
    );
    return { status: 200, body: 'OK' };
  }

  if (!orderId) {
    record('failed', 'missing_order_id', null, paymentId);
    return { status: 200, body: 'OK' };
  }

  const order = await deps.orders.findById(orderId);
  if (order?.provider_transaction_id && paymentId && order.provider_transaction_id !== paymentId) {
    recordSettlementAnomaly(events, log, orderId, 'provider_ref_mismatch');
    log.sys.error(
      { event: 'payment.webhook.provider_ref_mismatch', orderId, paymentId },
      '回调交易号与本地订单不一致，拒绝入账'
    );
    return { status: 200, body: 'OK' };
  }
  if (event.currency !== 'CNY') {
    recordSettlementAnomaly(events, log, orderId, 'currency_mismatch');
    log.sys.error(
      { event: 'payment.webhook.currency_mismatch', orderId, currency: event.currency },
      '回调币种不是 CNY，拒绝入账'
    );
    return { status: 200, body: 'OK' };
  }

  record('succeeded', null, orderId, paymentId);
  const settlement = await settlePaidOrder(
    { orderId, paidAmount: event.amount, providerTransactionId: paymentId ?? null },
    deps.orders,
    log,
    'webhook',
    events
  );
  // 只有我们自己的瞬时失败才要求平台重投；其余结果重投也不会变。
  return settlement === 'failed' ? { status: 500, body: 'retry' } : { status: 200, body: 'OK' };
}

/** 平台说已付款、我们却不能入账：写成 settlement 失败事件，让“已付款未履约”告警直接看到。 */
function recordSettlementAnomaly(
  events: PaymentEventRecorder | undefined,
  log: RequestLogger,
  orderId: string,
  errorClass: 'provider_ref_mismatch' | 'currency_mismatch'
) {
  recordPaymentOperationEvent(events, log, {
    event_key: `settlement:webhook:failed:${orderId}:${errorClass}:${Date.now()}`,
    order_id: orderId,
    user_id: null,
    event_kind: 'settlement',
    stage: 'settlement',
    outcome: 'failed',
    source: 'backend',
    trigger: 'settlement',
    error_class: errorClass,
    occurred_at: new Date().toISOString(),
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
