import type { CheckoutConfirmationAction, PostCheckoutConfirmationData } from '@miniapp/shared';
import type { MiniappPaymentOrderRepository } from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_BEFORE_ORDER_SKEW_MS = 5 * 60 * 1000;
const MAX_BACKFILL_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class CheckoutConfirmationError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_OCCURRED_AT',
    message: string
  ) {
    super(message);
  }
}

type ConfirmationOrders = Pick<
  MiniappPaymentOrderRepository,
  'findByIdForUser' | 'recordCheckoutConfirmation'
>;

/** The RPC repeats ownership under its row lock; this read supplies a safe HTTP 404 and time bounds. */
export class CheckoutConfirmationUseCase {
  constructor(private readonly orders: ConfirmationOrders) {}

  async record(input: {
    orderId: string;
    userId: string;
    requestId: string;
    occurredAt: string;
    action: CheckoutConfirmationAction;
    now?: number;
  }): Promise<PostCheckoutConfirmationData> {
    const order = await this.orders.findByIdForUser(input.orderId, input.userId);
    if (!order) throw new CheckoutConfirmationError('NOT_FOUND', 'Payment order not found');

    const occurredAt = Date.parse(input.occurredAt);
    const now = input.now ?? Date.now();
    const createdAt = Date.parse(order.created_at);
    if (
      !Number.isFinite(occurredAt) ||
      occurredAt > now + MAX_FUTURE_SKEW_MS ||
      occurredAt < now - MAX_BACKFILL_AGE_MS ||
      (Number.isFinite(createdAt) && occurredAt < createdAt - MAX_BEFORE_ORDER_SKEW_MS)
    ) {
      throw new CheckoutConfirmationError(
        'INVALID_OCCURRED_AT',
        'Invalid checkout confirmation time'
      );
    }

    return this.orders.recordCheckoutConfirmation({
      orderId: input.orderId,
      userId: input.userId,
      requestId: input.requestId,
      occurredAt: input.occurredAt,
      action: input.action,
    });
  }
}
