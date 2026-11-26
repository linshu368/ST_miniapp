import { describe, expect, it } from 'vitest';
import { FreeZoneConfigSchema } from '@miniapp/shared';
import { buildFreeZoneStatus } from './admin-status.js';

describe('buildFreeZoneStatus', () => {
  const config = FreeZoneConfigSchema.parse({
    candidates: ['a', 'b', 'c'].map((name) => ({
      id: `free-${name}`,
      surplus_model: name,
      display_name: name.toUpperCase(),
      family: 'x',
      benchmark_tier: 'light',
    })),
  });
  const at = new Date('2026-11-24T02:30:00Z');
  const row = (candidate_id: string, status: 'listed' | 'unlisted' | 'cooling') => ({
    candidate_id,
    surplus_model: candidate_id.replace('free-', ''),
    status,
    providers: status === 'listed' ? ['deepseek'] : [],
    provider_since: status === 'listed' ? at : null,
    last_metrics:
      candidate_id === 'free-b'
        ? { direct_price: { input_per_1m: 900000, output_per_1m: 1500000, source: 'OpenRouter' } }
        : { turns: 12, screening: { pass: true } },
    pinned: candidate_id === 'free-b',
  });
  const status = buildFreeZoneStatus(
    config,
    [row('free-gone', 'unlisted'), row('free-c', 'cooling'), row('free-b', 'listed')],
    [],
    [
      {
        candidate_id: 'free-a',
        ever_listed: true,
        last_delist_cause: 'official',
        last_delist_reason: '连续 10 次被拒单',
        last_delisted_at: at,
      },
    ]
  );

  it('orders by the published pool, keeps removed candidates last and treats old cooling rows as not listed', () => {
    expect(
      status.models.map((model) => [model.candidate_id, model.status, model.in_config])
    ).toEqual([
      ['free-a', 'unlisted', true],
      ['free-b', 'listed', true],
      ['free-c', 'unlisted', true],
      ['free-gone', 'unlisted', false],
    ]);
  });

  it('shows the fixed provider, the list price and the last delisting', () => {
    expect(status.models[1]).toMatchObject({
      pinned: true,
      providers: ['deepseek'],
      provider_since: at.toISOString(),
      direct_price: { input_per_1m: 900000, output_per_1m: 1500000, source: 'OpenRouter' },
      ever_listed: false,
      last_delist: null,
    });
    expect(status.models[0]).toMatchObject({
      direct_price: null,
      ever_listed: true,
      last_delist: { cause: 'official', at: at.toISOString(), reason: '连续 10 次被拒单' },
    });
    expect(status.models[2]?.direct_price).toBeNull();
    // 没有行的候选按未保上
    expect(status.models[0]?.pinned).toBe(false);
  });
});
