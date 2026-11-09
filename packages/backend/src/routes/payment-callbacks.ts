import type { FastifyInstance } from 'fastify';
import { requestLogger } from '../lib/logger.js';
import { config } from '../platform/config.js';
import { EpayPaymentGateway } from '../infrastructure/payment/EpayPaymentGateway.js';
import type { MiniappPaymentOrderRepository } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { reconcileWithGateway } from '../features/payment/usecases/PaymentSettlement.js';
import { handleEpayNotification } from '../features/payment/usecases/EpayNotification.js';
import { recordPaymentOperationEvent } from '../features/payment/usecases/PaymentOperationEvents.js';

export function registerPaymentCallbacks(
  app: FastifyInstance,
  deps: {
    orders: MiniappPaymentOrderRepository;
    gateway: EpayPaymentGateway;
  }
) {
  const { orders, gateway } = deps;
  // @frontend-ready: false -- provider GET callback; no user session, verified MD5 and order identity.
  app.get('/api/payment/notify/ttzf', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = request.raw.url?.split('?').slice(1).join('?') ?? '';
    const result = await handleEpayNotification(query, {
      gateway,
      orders,
      events: orders,
      log: requestLogger(request.log, 'payment'),
    });
    return reply.status(result.status).type('text/plain').send(result.body);
  });

  // @frontend-ready: true
  app.get('/api/payment/return', async (request, reply) => {
    const log = requestLogger(request.log, 'payment');
    const query = request.query as { order_id?: unknown; out_trade_no?: unknown };
    const rawOrderId = query.order_id ?? query.out_trade_no;
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

    if (orderId && gateway.configured) {
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
  const value = config.telegramMiniappShortName.replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : 'app';
}
