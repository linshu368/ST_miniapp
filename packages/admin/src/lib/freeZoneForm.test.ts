import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FREE_ZONE_CONFIG, FreeZoneConfigSchema } from '@miniapp/shared';
import {
  asFreeZoneConfig,
  deriveCandidateId,
  describeFreeZoneStatus,
  freeZoneIssues,
  parseMinutesList,
  toPeriodTime,
} from './freeZoneForm';

const candidate = {
  id: 'free-deepseek-v4-pro',
  surplus_model: 'deepseek-v4-pro',
  display_name: 'DeepSeek V4 Pro',
  tagline: '深度推理',
  family: 'deepseek',
  benchmark_tier: 'premium' as const,
};

describe('asFreeZoneConfig', () => {
  it('fills missing sections with defaults and keeps in-progress values', () => {
    const value = asFreeZoneConfig({ enabled: true, screening: { min_uptime_pct: null } });
    expect(value.enabled).toBe(true);
    expect(value.screening.min_uptime_pct).toBeNull();
    expect(value.screening.min_discount_pct).toBe(85);
    expect(value.first_token).toEqual(DEFAULT_FREE_ZONE_CONFIG.first_token);
    expect(asFreeZoneConfig('garbage')).toEqual(DEFAULT_FREE_ZONE_CONFIG);
  });

  it('round-trips a published config unchanged', () => {
    const published = FreeZoneConfigSchema.parse({ candidates: [candidate], scope: 'own_cards' });
    expect(asFreeZoneConfig(published)).toEqual(published);
  });
});

describe('freeZoneIssues', () => {
  it('is empty for the defaults', () => {
    expect(freeZoneIssues(DEFAULT_FREE_ZONE_CONFIG)).toEqual([]);
  });

  it('names the row and field in plain words', () => {
    const value = asFreeZoneConfig({
      candidates: [
        candidate,
        { ...candidate, id: 'deepseek', surplus_model: 'x', display_name: '' },
      ],
      screening: { min_discount_pct: null },
      first_token: { primary_wait_ms: 8000, deadline_ms: 7500 },
    });
    const issues = freeZoneIssues(value);
    expect(issues).toContain('候选池 · 第 2 行 · 免费模型 id：免费模型 id 必须以 free- 开头');
    expect(issues).toContain('候选池 · 第 2 行 · 显示名：不能为空');
    expect(issues).toContain('官方数据初筛 · 折扣底线：不能留空');
    expect(issues).toContain('首字 · 启动兜底等待：启动兜底的等待时间必须短于首字总上限');
  });
});

describe('form helpers', () => {
  it('derives a free- id from the Surplus model name', () => {
    expect(deriveCandidateId('gemini-3.1-flash-lite')).toBe('free-gemini-3-1-flash-lite');
    expect(deriveCandidateId('  ')).toBe('');
  });

  it('stores period times with an offset that the schema accepts', () => {
    const iso = toPeriodTime(dayjs('2026-11-12T20:30:45'));
    expect(iso).toMatch(/^2026-11-12T20:30:00[+-]\d\d:\d\d$/);
    expect(
      FreeZoneConfigSchema.safeParse({
        period: { starts_at: iso, ends_at: toPeriodTime(dayjs('2026-11-19T20:30')) },
      }).success
    ).toBe(true);
  });

  it('parses the cooldown ladder with either comma', () => {
    expect(parseMinutesList('1440, 4320，10080')).toEqual([1440, 4320, 10080]);
  });
});

describe('describeFreeZoneStatus', () => {
  const period = { starts_at: '2026-11-12T00:00:00+08:00', ends_at: '2026-11-19T00:00:00+08:00' };
  const config = (patch: object) => asFreeZoneConfig({ enabled: true, period, ...patch });

  it('walks through closed, missing period, upcoming, open and ended', () => {
    const at = (iso: string) => new Date(iso);
    expect(
      describeFreeZoneStatus(config({ enabled: false }), at('2026-11-15T00:00:00Z')).type
    ).toBe('info');
    expect(
      describeFreeZoneStatus(config({ period: null }), at('2026-11-15T00:00:00Z')).text
    ).toContain('还没填福利期');
    expect(describeFreeZoneStatus(config({}), at('2026-11-11T00:00:00Z')).text).toContain('开始');
    const open = describeFreeZoneStatus(config({ scope: 'own_cards' }), at('2026-11-15T00:00:00Z'));
    expect(open.type).toBe('success');
    expect(open.text).toContain('仅限自创角色卡');
    expect(describeFreeZoneStatus(config({}), at('2026-11-20T00:00:00Z')).text).toContain(
      '已经结束'
    );
  });
});
