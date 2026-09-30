import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noFreeQuotaReservation, reserveCharacterFreeQuota } from './quota.js';
import type { GenerationLogger } from './types.js';

const quotaMocks = vi.hoisted(() => ({ limit: vi.fn(), reserve: vi.fn(), finalize: vi.fn() }));
vi.mock('../billing/free-quota.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../billing/free-quota.js')>()),
  getCharacterFreeChatQuotaLimit: quotaMocks.limit,
}));
vi.mock('../../infrastructure/repositories/MiniappCharacterFreeQuotaRepository.js', () => ({
  MiniappCharacterFreeQuotaRepository: class {
    reserve = quotaMocks.reserve;
    finalize = quotaMocks.finalize;
  },
}));
beforeEach(() => {
  quotaMocks.limit.mockReset().mockResolvedValue(50);
  quotaMocks.reserve
    .mockReset()
    .mockResolvedValue({ grantedFree: true, status: 'reserved', remainingRounds: 49 });
  quotaMocks.finalize.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeLogger(): GenerationLogger {
  const sink = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
    child: vi.fn(),
  };
  return Object.assign({ ...sink }, { biz: sink, sys: sink }) as unknown as GenerationLogger;
}

const CHARACTER_ID = '11111111-2222-4333-8444-555555555555';

describe('noFreeQuotaReservation', () => {
  it('付费模型不占用免费额度，finalize 是 no-op', async () => {
    const reservation = noFreeQuotaReservation();
    expect(reservation).toMatchObject({ isFreeRound: false, granted: false });
    await expect(reservation.finalize(true)).resolves.toBeNull();
  });
});

describe('reserveCharacterFreeQuota', () => {
  it('付费模型不进免费额度体系', async () => {
    const log = fakeLogger();
    const reservation = await reserveCharacterFreeQuota({
      chargeId: 'charge-1',
      userId: 'user-1',
      characterId: CHARACTER_ID,
      billing: { isFree: false },
      log,
    });

    expect(reservation).toMatchObject({ isFreeRound: false, granted: false });
    expect(log.biz.info).not.toHaveBeenCalled();
  });

  it('免费模型但轮次无法归属到角色卡时按额度耗尽计费并放行', async () => {
    const log = fakeLogger();
    for (const characterId of [null, 'not-a-uuid']) {
      const reservation = await reserveCharacterFreeQuota({
        chargeId: 'charge-2',
        userId: 'user-1',
        characterId,
        billing: { isFree: true },
        log,
      });

      expect(reservation).toMatchObject({ isFreeRound: false, granted: false });
      await expect(reservation.finalize(true)).resolves.toBeNull();
    }
    expect(log.biz.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'llm.free_quota.skipped_untrackable_character' }),
      expect.any(String)
    );
  });
});

describe('quota reservation cancellation boundary', () => {
  const request = (signal?: AbortSignal) => ({
    chargeId: 'charge',
    userId: 'user',
    characterId: CHARACTER_ID,
    billing: { isFree: true },
    log: fakeLogger(),
    signal,
  });

  it('aborted delayed config read never creates a late reservation', async () => {
    const controller = new AbortController();
    let resolveLimit: ((value: number) => void) | undefined;
    quotaMocks.limit.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveLimit = resolve;
        })
    );
    const result = reserveCharacterFreeQuota(request(controller.signal));
    const rejected = expect(result).rejects.toThrow('cancelled');
    controller.abort(new Error('cancelled'));
    await rejected;
    resolveLimit?.(50);
    await Promise.resolve();
    expect(quotaMocks.reserve).not.toHaveBeenCalled();
  });

  it('configuration timeout is ordinary failure without an uncertain quota write', async () => {
    vi.useFakeTimers();
    // Native AbortSignal.timeout uses Node internal timers, not Vitest fake timers.
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      setTimeout(() => controller.abort(new Error('configuration timeout')), milliseconds);
      return controller.signal;
    });
    quotaMocks.limit.mockReturnValue(new Promise<number>(() => {}));
    const result = reserveCharacterFreeQuota(request());
    const rejected = expect(result).rejects.not.toMatchObject({
      name: 'GenerationCleanupPendingError',
    });
    await vi.advanceTimersByTimeAsync(5_001);
    await rejected;
    expect(quotaMocks.reserve).not.toHaveBeenCalled();
  });

  it('actual reserve RPC failure is flagged for persisted recovery', async () => {
    quotaMocks.reserve.mockRejectedValue(new Error('RPC outcome uncertain'));
    await expect(reserveCharacterFreeQuota(request())).rejects.toMatchObject({
      name: 'GenerationCleanupPendingError',
    });
    expect(quotaMocks.reserve).toHaveBeenCalledTimes(1);
  });
});
