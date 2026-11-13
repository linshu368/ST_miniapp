import { describe, expect, it } from 'vitest';
import type { AdminFreeZoneStatusModel } from '@miniapp/shared';
import {
  freeZoneBusinessText,
  freeZoneProbeText,
  freeZoneReasonView,
  freeZoneStatusGroup,
  freeZoneStatusLabel,
  isFreeZoneManualHold,
} from './freeZoneApi';

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
    probe: null,
    business: null,
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

describe('freeZoneProbeText', () => {
  it('shows the probed first-token time for a routed probe only', () => {
    const probe = (outcome: 'ok' | 'unroutable', ms: number | null) => ({
      provider: 'deepseek',
      outcome,
      first_token_ms: ms,
      detail: null,
    });
    expect(freeZoneProbeText(model({ probe: probe('ok', 2254) }))).toBe('探测首字 2.3 秒');
    expect(freeZoneProbeText(model({ probe: probe('unroutable', null) }))).toBe('');
    expect(freeZoneProbeText(model({}))).toBe('');
  });

  it('names the blocked channel when it is the only trusted provider', () => {
    const view = freeZoneReasonView(
      model({
        last_reason: '只有屏蔽渠道：dashscope-cn',
        screening: {
          pass: false,
          checks: [{ key: 'min_qualified_offers', threshold: 1, passed: 0, total: 0 }],
          closest: null,
        },
      })
    );
    expect(view).toMatchObject({
      kind: 'tags',
      tags: [{ text: '只有屏蔽渠道：dashscope-cn', failed: true }],
    });
  });

  it('labels the probe check with how many providers routed', () => {
    const view = freeZoneReasonView(
      model({
        screening: {
          pass: false,
          checks: [{ key: 'probe', threshold: 85, passed: 0, total: 2 }],
          closest: null,
        },
      })
    );
    expect(view).toMatchObject({
      kind: 'tags',
      tags: [
        {
          text: '探测派单 0/2',
          failed: true,
          hint: '真发请求探了 2 家，0 家带 85% 折扣底线派得出去',
        },
      ],
    });
  });
});

describe('freeZoneBusinessText', () => {
  const business = {
    turns: 78,
    fallback_delivered_pct: 39.74,
    no_output_pct: 41,
    primary_delivered_turns: 46,
    interrupted_turns: 14,
    interrupted_pct: 30.43,
    ttft_p90_ms: 9000,
  };

  it('puts fallback and mid-generation interruption side by side', () => {
    expect(freeZoneBusinessText(model({ status: 'listed', business }))).toBe(
      '78 轮 · 兜底 39.7% · 中断 30.4%（14/46） · 没出字 41%'
    );
  });

  it('copes with evaluations recorded before the interruption fields existed', () => {
    const old = {
      ...business,
      primary_delivered_turns: null,
      interrupted_turns: null,
      interrupted_pct: null,
    };
    expect(freeZoneBusinessText(model({ status: 'listed', business: old }))).toBe(
      '78 轮 · 兜底 39.7% · 中断 — · 没出字 41%'
    );
    expect(
      freeZoneBusinessText(model({ status: 'listed', business: { ...business, turns: 0 } }))
    ).toBe('还没有用户轮次');
    expect(freeZoneBusinessText(model({ status: 'unlisted' }))).toBe('');
  });
});

describe('manual hold', () => {
  const held = model({
    status: 'cooling',
    cooldown_until: '2100-01-01T00:00:00.000Z',
    last_delist: { cause: null, at: '2026-11-13T08:00:00.000Z', reason: '运营手动下架' },
  });

  it('labels a manually delisted model instead of showing the cooldown', () => {
    expect(isFreeZoneManualHold(held)).toBe(true);
    expect(freeZoneStatusLabel(held)).toBe('手动下架');
  });

  it('keeps automatic cooldowns and other states as they are', () => {
    const cooling = model({
      status: 'cooling',
      last_delist: { cause: 'official', at: '2026-11-13T08:00:00.000Z', reason: 'x' },
    });
    expect(isFreeZoneManualHold(cooling)).toBe(false);
    expect(freeZoneStatusLabel(cooling)).toBe('冷却中');
    expect(freeZoneStatusLabel(model({ status: 'listed' }))).toBe('在架');
    expect(freeZoneStatusLabel(model({ status: null }))).toBe('未评估');
  });
});
