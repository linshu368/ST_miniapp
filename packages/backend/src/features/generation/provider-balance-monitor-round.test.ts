import { describe, expect, it, vi } from 'vitest';
import { runProviderBalanceMonitorRound } from './provider-balance-monitor-round.js';

describe('runProviderBalanceMonitorRound', () => {
  const log = () => ({ sys: { error: vi.fn() } }) as never;

  it('runs both providers and marks a probe failure partial', async () => {
    const venice = { runOnce: vi.fn(async () => ({ outcome: 'probe_failed' as const })) };
    const surplus = { runOnce: vi.fn(async () => ({ outcome: 'ok' as const })) };

    await expect(runProviderBalanceMonitorRound({ venice, surplus, log: log() })).resolves.toBe(
      'partial'
    );
    expect(venice.runOnce).toHaveBeenCalledOnce();
    expect(surplus.runOnce).toHaveBeenCalledOnce();
  });

  it('isolates a thrown provider failure and still runs the next monitor', async () => {
    const venice = { runOnce: vi.fn(async () => Promise.reject(new Error('venice down'))) };
    const surplus = { runOnce: vi.fn(async () => ({ outcome: 'skipped' as const })) };
    const error = vi.fn();
    const logger = { sys: { error } } as never;

    await expect(runProviderBalanceMonitorRound({ venice, surplus, log: logger })).resolves.toBe(
      'partial'
    );
    expect(surplus.runOnce).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it('keeps the round successful when configured providers are healthy or skipped', async () => {
    const venice = { runOnce: vi.fn(async () => ({ outcome: 'ok' as const })) };
    const surplus = { runOnce: vi.fn(async () => ({ outcome: 'skipped' as const })) };
    await expect(runProviderBalanceMonitorRound({ venice, surplus, log: log() })).resolves.toBe(
      'success'
    );
  });
});
