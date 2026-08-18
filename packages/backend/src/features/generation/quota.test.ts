import { describe, expect, it, vi } from 'vitest';
import { noFreeQuotaReservation, reserveCharacterFreeQuota } from './quota.js';
import type { GenerationLogger } from './types.js';

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
