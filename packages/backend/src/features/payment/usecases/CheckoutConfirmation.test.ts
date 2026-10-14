import { describe, expect, it, vi } from 'vitest';

import { CheckoutConfirmationError, CheckoutConfirmationUseCase } from './CheckoutConfirmation.js';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const USER_ID = '00000000-0000-0000-0000-000000000001';
const REQUEST_ID = '00000000-0000-0000-0000-000000000002';

function orders() {
  return {
    findByIdForUser: vi.fn<() => Promise<{ created_at: string } | null>>(async () => ({
      created_at: '2026-10-10T11:50:00.000Z',
    })),
    recordCheckoutConfirmation: vi
      .fn()
      .mockResolvedValueOnce({
        recorded: true,
        checkout_confirmed_at: '2026-10-10T11:55:00.000Z',
        last_checkout_confirmed_at: '2026-10-10T11:55:00.000Z',
        checkout_confirm_count: 1,
      })
      .mockResolvedValueOnce({
        recorded: false,
        checkout_confirmed_at: '2026-10-10T11:55:00.000Z',
        last_checkout_confirmed_at: '2026-10-10T11:55:00.000Z',
        checkout_confirm_count: 1,
      }),
  };
}

describe('CheckoutConfirmationUseCase', () => {
  it('preserves the RPC replay result for one request id', async () => {
    const repository = orders();
    const usecase = new CheckoutConfirmationUseCase(repository as never);
    const input = {
      orderId: 'MA-checkout-1',
      userId: USER_ID,
      requestId: REQUEST_ID,
      occurredAt: '2026-10-10T11:55:00.000Z',
      action: 'initial_open' as const,
      now: NOW,
    };

    await expect(usecase.record(input)).resolves.toMatchObject({
      recorded: true,
      checkout_confirm_count: 1,
    });
    await expect(usecase.record(input)).resolves.toMatchObject({
      recorded: false,
      checkout_confirm_count: 1,
    });
    expect(repository.recordCheckoutConfirmation).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-owner before invoking the confirmation RPC', async () => {
    const repository = orders();
    repository.findByIdForUser.mockResolvedValueOnce(null);
    const usecase = new CheckoutConfirmationUseCase(repository as never);

    await expect(
      usecase.record({
        orderId: 'MA-other-user',
        userId: USER_ID,
        requestId: REQUEST_ID,
        occurredAt: '2026-10-10T11:55:00.000Z',
        action: 'initial_open',
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(repository.recordCheckoutConfirmation).not.toHaveBeenCalled();
  });

  it.each([
    ['too far in the future', '2026-10-10T12:06:00.000Z'],
    ['before the order existed', '2026-10-10T11:40:00.000Z'],
    ['outside the backfill period', '2026-09-09T11:55:00.000Z'],
  ])('rejects occurred_at %s', async (_case, occurredAt) => {
    const repository = orders();
    const usecase = new CheckoutConfirmationUseCase(repository as never);

    await expect(
      usecase.record({
        orderId: 'MA-checkout-1',
        userId: USER_ID,
        requestId: REQUEST_ID,
        occurredAt,
        action: 'reopen',
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'INVALID_OCCURRED_AT' });
    expect(repository.recordCheckoutConfirmation).not.toHaveBeenCalled();
  });
});
