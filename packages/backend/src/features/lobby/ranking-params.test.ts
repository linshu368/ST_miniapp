import { DEFAULT_LOBBY_RANKING_PARAMS, LobbyRankingParamsSchema } from '@miniapp/shared';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLobbyRankingParams } from './ranking-params.js';

const fetchRuntimeConfigEntry = vi.hoisted(() => vi.fn());

vi.mock('../../platform/runtime-config.js', () => ({ fetchRuntimeConfigEntry }));

function createLog() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  } as unknown as FastifyBaseLogger & { error: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('LobbyRankingParamsSchema', () => {
  it('内置默认值本身必须过校验', () => {
    expect(LobbyRankingParamsSchema.safeParse(DEFAULT_LOBBY_RANKING_PARAMS).success).toBe(true);
  });

  it('权重和不为 1 时拒绝：分数会不再是百分制', () => {
    const parsed = LobbyRankingParamsSchema.safeParse({
      ...DEFAULT_LOBBY_RANKING_PARAMS,
      d30_weight: 0.8,
      r48_weight: 0.3,
    });
    expect(parsed.success).toBe(false);
  });

  it('分位点低位不小于高位时拒绝：归一化区间会退化', () => {
    for (const [low, high] of [
      [0.9, 0.1],
      [0.5, 0.5],
    ]) {
      const parsed = LobbyRankingParamsSchema.safeParse({
        ...DEFAULT_LOBBY_RANKING_PARAMS,
        norm_percentile_low: low,
        norm_percentile_high: high,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('回溯天数接受 null（不限），拒绝 0 与小数', () => {
    const check = (value: unknown) =>
      LobbyRankingParamsSchema.safeParse({
        ...DEFAULT_LOBBY_RANKING_PARAMS,
        first_touch_lookback_days: value,
      }).success;

    expect(check(null)).toBe(true);
    expect(check(90)).toBe(true);
    expect(check(0)).toBe(false);
    expect(check(1.5)).toBe(false);
  });

  it('整数项拒绝小数：窗口天数、轮次上限这些会被当成 int 参数下传 SQL', () => {
    for (const key of ['window_days', 'turn_cap', 'session_gap_minutes', 'min_users'] as const) {
      const parsed = LobbyRankingParamsSchema.safeParse({
        ...DEFAULT_LOBBY_RANKING_PARAMS,
        [key]: 10.5,
      });
      expect(parsed.success, key).toBe(false);
    }
  });
});

describe('resolveLobbyRankingParams', () => {
  it('配置合法时原样返回，并带上版本号', async () => {
    const value = { ...DEFAULT_LOBBY_RANKING_PARAMS, window_days: 42 };
    fetchRuntimeConfigEntry.mockResolvedValue({ value, textValue: null, version: 7 });
    const log = createLog();

    const resolved = await resolveLobbyRankingParams(log);

    expect(resolved.params.window_days).toBe(42);
    expect(resolved.degraded).toBe(false);
    expect(resolved.version).toBe(7);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('配置缺失时回落到内置默认值，并打错误日志', async () => {
    fetchRuntimeConfigEntry.mockResolvedValue(null);
    const log = createLog();

    const resolved = await resolveLobbyRankingParams(log);

    expect(resolved.params).toEqual(DEFAULT_LOBBY_RANKING_PARAMS);
    expect(resolved.degraded).toBe(true);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('配置不合契约时回落并打日志——否则这一轮分数是按哪套口径算的没人知道', async () => {
    fetchRuntimeConfigEntry.mockResolvedValue({
      value: { ...DEFAULT_LOBBY_RANKING_PARAMS, d30_weight: 0.9 },
      textValue: null,
      version: 12,
    });
    const log = createLog();

    const resolved = await resolveLobbyRankingParams(log);

    expect(resolved.params).toEqual(DEFAULT_LOBBY_RANKING_PARAMS);
    expect(resolved.degraded).toBe(true);
    expect(resolved.version).toBeNull();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[0]).toMatchObject({
      event: 'lobby_ranking.params_invalid',
      configVersion: 12,
    });
  });
});
