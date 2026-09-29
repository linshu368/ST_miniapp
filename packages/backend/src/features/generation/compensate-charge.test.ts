import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationLogger } from './types.js';

const { refundLlmUsageCharge } = vi.hoisted(() => ({
  refundLlmUsageCharge: vi.fn(),
}));

vi.mock('../../infrastructure/repositories/MiniappWalletRepository.js', () => ({
  MiniappWalletRepository: class {
    refundLlmUsageCharge = refundLlmUsageCharge;
  },
}));

const { compensateDebitedLlmCharge } = await import('./compensate-charge.js');

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

describe('compensateDebitedLlmCharge', () => {
  beforeEach(() => {
    refundLlmUsageCharge.mockReset();
  });

  it('delegates to the refund RPC and does not edit wallet balances itself', async () => {
    refundLlmUsageCharge.mockResolvedValue({ status: 'refunded', wallet: null });
    const log = fakeLogger();
    await expect(
      compensateDebitedLlmCharge({ chargeId: 'charge-1', reason: 'post_debit_failure', log })
    ).resolves.toBe('refunded');
    expect(refundLlmUsageCharge).toHaveBeenCalledWith({
      chargeId: 'charge-1',
      reason: 'post_debit_failure',
    });
    expect(log.biz.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'llm.billing.compensate', status: 'refunded' }),
      expect.any(String)
    );
  });

  it('returns already_refunded without a second credit', async () => {
    refundLlmUsageCharge.mockResolvedValue({ status: 'already_refunded', wallet: null });
    await expect(
      compensateDebitedLlmCharge({
        chargeId: 'charge-1',
        reason: 'post_debit_failure',
        log: fakeLogger(),
      })
    ).resolves.toBe('already_refunded');
    expect(refundLlmUsageCharge).toHaveBeenCalledTimes(1);
  });
});
