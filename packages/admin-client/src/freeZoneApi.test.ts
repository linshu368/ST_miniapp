import { describe, expect, it } from 'vitest';
import type { AdminFreeZoneStatusModel } from '@miniapp/shared';
import { freeZoneReasonView, freeZoneStatusGroup } from './freeZoneApi';

function model(patch: Partial<AdminFreeZoneStatusModel>): AdminFreeZoneStatusModel {
  return {
    candidate_id: 'free-x',
    display_name: 'X',
    surplus_model: 'x',
    in_config: true,
    status: 'unlisted',
    providers: [],
    provider_since: null,
    consecutive_passes: 0,
    cooldown_until: null,
    excluded_providers: {},
    last_reason: 'raw reason',
    screening: null,
    ever_listed: false,
    last_delist: null,
    evaluated_at: null,
    ...patch,
  };
}

const check = (key: 'min_qualified_offers' | 'min_samples' | 'min_tps', passed: number) => ({
  key,
  threshold: 5,
  passed,
  total: 3,
});

describe('freeZoneReasonView', () => {
  it('says nothing for listed models and models that passed screening', () => {
    expect(freeZoneReasonView(model({ status: 'listed' }))).toEqual({ kind: 'none' });
    const passed = model({
      last_reason: null,
      screening: { pass: true, checks: [], closest: null },
    });
    expect(freeZoneReasonView(passed)).toEqual({ kind: 'none' });
  });

  it('falls back to the raw text before the summary exists', () => {
    expect(freeZoneReasonView(model({}))).toEqual({ kind: 'text', text: 'raw reason' });
  });

  it('puts the checks no provider passes first, in red', () => {
    const view = freeZoneReasonView(
      model({
        screening: {
          pass: false,
          checks: [
            check('min_samples', 3),
            check('min_qualified_offers', 0),
            { key: 'min_tps', threshold: null, passed: 0, total: 3 },
          ],
          closest: { provider: 'venice', failed: ['min_qualified_offers'] },
        },
      })
    );
    expect(view).toEqual({
      kind: 'tags',
      tags: [
        { text: '达标报价数 0/3', failed: true, hint: '3 家 trusted 供应商里有 0 家过了' },
        { text: '样本量 3/3', failed: false, hint: '3 家 trusted 供应商里有 3 家过了' },
      ],
      note: null,
    });
  });

  it('explains when every check has a provider but none passes them all', () => {
    const view = freeZoneReasonView(
      model({
        screening: {
          pass: false,
          checks: [check('min_samples', 1), check('min_tps', 2)],
          closest: { provider: 'zai', failed: ['min_samples'] },
        },
      })
    );
    expect(view.kind === 'tags' && view.note).toBe(
      '每项都有供应商过，但没有一家全过；最接近的 zai 差：样本量'
    );
  });
});

describe('freeZoneStatusGroup', () => {
  const delist = (cause: 'official' | 'business') => ({
    cause,
    at: '2026-11-12T04:00:00.000Z',
    reason: 'x',
  });

  it('splits listed, business-delisted and everything else', () => {
    expect(freeZoneStatusGroup(model({ status: 'listed', last_delist: delist('business') }))).toBe(
      'listed'
    );
    expect(freeZoneStatusGroup(model({ status: 'cooling', last_delist: delist('business') }))).toBe(
      'business_delisted'
    );
    // 冷却期满回到未上架、还没重新达标：仍算业务下架那块
    expect(
      freeZoneStatusGroup(model({ status: 'unlisted', last_delist: delist('business') }))
    ).toBe('business_delisted');
    expect(
      freeZoneStatusGroup(
        model({ status: 'cooling', ever_listed: true, last_delist: delist('official') })
      )
    ).toBe('not_listed');
    expect(freeZoneStatusGroup(model({ status: null }))).toBe('not_listed');
  });
});
