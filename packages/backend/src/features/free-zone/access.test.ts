import { describe, expect, it } from 'vitest';
import { FreeZoneConfigSchema } from '@miniapp/shared';
import {
  evaluateFreeZoneAccess,
  needsAccessFacts,
  weeklyWindows,
  type FreeZoneAccessFacts,
} from './access.js';

// 2026-11-26、12-03 是周四。时间都写北京时间（+08:00）。
const bj = (local: string) => new Date(`${local}+08:00`);
const iso = (local: string) => bj(local).toISOString();

const config = FreeZoneConfigSchema.parse({
  enabled: true,
  period: { starts_at: '2026-11-11T00:00:00+08:00', ends_at: '2026-11-22T00:00:00+08:00' },
  access: {
    enabled: true,
    trial_since: '2026-11-22T00:00:00+08:00',
    trial_hours: 72,
    vip_welcome_days: 5,
    vip_weekly: { weekday: 4, start_minute: 720, duration_minutes: 900 },
  },
});

const oldUser: FreeZoneAccessFacts = {
  createdAt: '2026-11-15T10:00:00+08:00',
  vipValidUntil: null,
  lastVipGrantAt: null,
};
const vipUser: FreeZoneAccessFacts = {
  ...oldUser,
  vipValidUntil: '2026-12-31T00:00:00+08:00',
  lastVipGrantAt: '2026-11-01T10:00:00+08:00',
};

const run = (now: string, facts: FreeZoneAccessFacts | null, cfg = config) =>
  evaluateFreeZoneAccess({ config: cfg, now: bj(now), facts });

describe('weeklyWindows', () => {
  const weekly = config.access.vip_weekly;
  const at = (local: string) => weeklyWindows(weekly, bj(local).getTime());

  it('opens Thursday 12:00 and closes Friday 03:00 Beijing time', () => {
    expect(at('2026-11-26T11:59:59').current).toBeNull();
    expect(at('2026-11-26T11:59:59').next.startsAt).toBe(bj('2026-11-26T12:00:00').getTime());
    expect(at('2026-11-26T12:00:00').current?.endsAt).toBe(bj('2026-11-27T03:00:00').getTime());
    expect(at('2026-11-27T02:59:59').current).not.toBeNull();
    expect(at('2026-11-27T03:00:00').current).toBeNull();
    expect(at('2026-11-27T03:00:00').next.startsAt).toBe(bj('2026-12-03T12:00:00').getTime());
  });

  it('handles the Beijing date differing from the UTC date and year ends', () => {
    // 北京周四 07:00 = UTC 周三 23:00
    expect(at('2026-11-26T07:00:00').next.startsAt).toBe(bj('2026-11-26T12:00:00').getTime());
    // 2026-12-31 是周四
    expect(at('2026-12-31T23:00:00').current?.endsAt).toBe(bj('2027-01-01T03:00:00').getTime());
  });
});

describe('evaluateFreeZoneAccess', () => {
  it('keeps the welfare-only behaviour when access is off', () => {
    const off = FreeZoneConfigSchema.parse({ ...config, access: { enabled: false } });
    expect(run('2026-11-20T12:00:00', null, off).state).toEqual({
      kind: 'open',
      via: 'welfare',
      endsAt: bj('2026-11-22T00:00:00').getTime(),
    });
    expect(run('2026-11-26T13:00:00', vipUser, off).state.kind).toBe('hidden');
    expect(run('2026-11-10T13:00:00', null, off).state.kind).toBe('not_started');
    expect(needsAccessFacts(off, bj('2026-11-26T13:00:00'))).toBe(false);
  });

  it('opens for everyone during the welfare period without reading facts', () => {
    expect(needsAccessFacts(config, bj('2026-11-20T12:00:00'))).toBe(false);
    expect(run('2026-11-20T12:00:00', null).audience).toBe('everyone');
    expect(needsAccessFacts(config, bj('2026-11-22T00:00:00'))).toBe(true);
  });

  it('gives non-members the VIP-only state with the current or next VIP day', () => {
    const outside = run('2026-11-25T20:00:00', oldUser);
    expect(outside.audience).toBe('non_vip');
    expect(outside.state).toEqual({
      kind: 'vip_only',
      vipDay: {
        open: false,
        startsAt: bj('2026-11-26T12:00:00').getTime(),
        endsAt: bj('2026-11-27T03:00:00').getTime(),
      },
    });
    const during = run('2026-11-26T20:00:00', oldUser).state;
    expect(during).toMatchObject({ kind: 'vip_only', vipDay: { open: true } });
  });

  it('opens on the VIP day for members and waits otherwise', () => {
    expect(run('2026-11-26T13:00:00', vipUser).state).toEqual({
      kind: 'open',
      via: 'vip_weekly',
      endsAt: bj('2026-11-27T03:00:00').getTime(),
    });
    expect(run('2026-11-27T03:00:00', vipUser).state).toEqual({
      kind: 'vip_waiting',
      startsAt: bj('2026-12-03T12:00:00').getTime(),
    });
  });

  it('cuts member windows at expiry and treats expired members as non-members', () => {
    const expiring = { ...vipUser, vipValidUntil: '2026-11-26T15:00:00+08:00' };
    expect(run('2026-11-26T13:00:00', expiring).state).toMatchObject({
      kind: 'open',
      endsAt: bj('2026-11-26T15:00:00').getTime(),
    });
    expect(run('2026-11-26T15:00:00', expiring).audience).toBe('non_vip');
    // 下一个周四前就到期：不显示「等下次」，按会员专享（续费）处理
    const beforeNext = { ...vipUser, vipValidUntil: '2026-11-30T00:00:00+08:00' };
    expect(run('2026-11-27T10:00:00', beforeNext).state.kind).toBe('vip_only');
  });

  it('opens the welcome window after a purchase and picks the later end on overlap', () => {
    const fresh = { ...vipUser, lastVipGrantAt: '2026-11-23T10:00:00+08:00' };
    expect(run('2026-11-24T09:00:00', fresh).state).toEqual({
      kind: 'open',
      via: 'vip_welcome',
      endsAt: bj('2026-11-28T10:00:00').getTime(),
    });
    expect(run('2026-11-26T13:00:00', fresh).state).toMatchObject({
      via: 'vip_welcome',
      endsAt: bj('2026-11-28T10:00:00').getTime(),
    });
    const late = { ...vipUser, lastVipGrantAt: '2026-11-22T00:00:00+08:00' };
    expect(run('2026-11-26T13:00:00', late).state).toMatchObject({
      via: 'vip_weekly',
      endsAt: bj('2026-11-27T03:00:00').getTime(),
    });
  });

  it('gives new users a 72-hour trial from registration', () => {
    const newbie = { ...oldUser, createdAt: '2026-11-23T09:00:00+08:00' };
    const trial = run('2026-11-25T09:00:00', newbie);
    expect(trial).toMatchObject({ audience: 'trial', inTrial: true });
    expect(trial.state).toMatchObject({
      via: 'trial',
      endsAt: bj('2026-11-26T09:00:00').getTime(),
    });
    const ended = run('2026-11-26T09:00:00', newbie);
    expect(ended).toMatchObject({ audience: 'non_vip', inTrial: false });
    expect(ended.recentlyEnded).toEqual({
      reason: 'trial',
      at: bj('2026-11-26T09:00:00').getTime(),
    });
    // 试用开始前注册的老用户没有试用
    expect(run('2026-11-23T10:00:00', oldUser).inTrial).toBe(false);
  });

  it('reports a recent welfare end only for users who were around and only for 7 days', () => {
    expect(run('2026-11-23T10:00:00', oldUser).recentlyEnded).toEqual({
      reason: 'welfare',
      at: bj('2026-11-22T00:00:00').getTime(),
    });
    expect(run('2026-11-29T00:00:00', oldUser).recentlyEnded).toBeNull();
    const newbie = { ...oldUser, createdAt: '2026-11-23T09:00:00+08:00' };
    expect(run('2026-11-23T10:00:00', newbie).recentlyEnded).toBeNull();
  });

  it('lets users through temporarily when facts could not be read', () => {
    const degraded = run('2026-11-25T20:00:00', null);
    expect(degraded.degraded).toBe(true);
    expect(degraded.state).toMatchObject({ kind: 'open', via: null });
  });

  it('describes the rules for the frontend copy', () => {
    expect(run('2026-11-25T20:00:00', oldUser).publicAccess).toEqual({
      via: null,
      audience: 'non_vip',
      trial_hours: 72,
      vip_welcome_days: 5,
      vip_weekly: { weekday: 4, start_minute: 720, duration_minutes: 900 },
    });
    expect(iso('2026-11-26T12:00:00')).toBe('2026-11-26T04:00:00.000Z');
  });
});
