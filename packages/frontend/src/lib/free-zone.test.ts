import { describe, expect, it } from 'vitest';
import type { ChatMessage, GetModelCatalogData, PublicFreeZone } from '@miniapp/shared';

import {
  formatFreeZoneTime,
  freeZoneBoundaryDelay,
  freeZoneHasTurnLimits,
  freeZoneLimitHint,
  freeZoneModelResetsAt,
  freeZoneRulesText,
  freeZoneStatusText,
  freeZoneSwitchDividers,
  freeZoneSwitchNoticeText,
  remainingText,
  vipFreeChatTerms,
} from './free-zone';

const now = new Date('2026-11-25T12:00:00+08:00');
const access = {
  via: null,
  audience: 'non_vip' as const,
  trial_hours: 72,
  vip_welcome_days: 5,
  vip_weekly: { weekday: 4, start_minute: 720, duration_minutes: 900 },
};
const base = { rules: '免费模型会定期更换', models: [] };

function message(turn: number, role: ChatMessage['role'], credits?: number): ChatMessage {
  return {
    ...(credits !== undefined ? { credits_per_turn: credits } : {}),
    id: `${role}-${turn}`,
    session_id: 's',
    turn_index: turn,
    role,
    revision: 1,
    content: '',
    status: 'complete',
    error_code: null,
    finish_reason: null,
    model_id: null,
    created_at: now.toISOString(),
  };
}

function catalog(zone: PublicFreeZone | null): GetModelCatalogData {
  return {
    catalog: {
      default_model_id: 'light-1017',
      tiers: [
        {
          key: 'light',
          label: '轻量',
          color: '#4ade80',
          cost_hint: '',
          sort_order: 0,
          models: [{ id: 'light-1017', display_name: 'DeepSeek V4.1 Flash 1017' } as never],
          payable_credits: 15,
        },
      ],
    },
    selected_model_id: 'light-1017',
    selected_openrouter_model_id: 'x',
    catalog_version: 1,
    free_zone: zone,
  };
}

describe('freeZoneSwitchDividers', () => {
  const messages = [
    message(1, 'user'),
    message(1, 'assistant', 0),
    message(2, 'user'),
    message(2, 'assistant', 15),
    message(3, 'user'),
    message(3, 'assistant', 15),
  ];

  it('puts the reason on the latest free-to-paid turn when the zone is closed now', () => {
    const waiting: PublicFreeZone = {
      state: 'vip_waiting',
      starts_at: '2026-11-26T12:00:00+08:00',
      ...base,
      access: { ...access, audience: 'vip' },
    };
    const dividers = freeZoneSwitchDividers(messages, catalog(waiting), now);
    expect(Object.keys(dividers)).toEqual(['user-2']);
    // 时间按手机本地时区写，CI 时区不同，这里只核对结构
    expect(dividers['user-2']?.title).toBe('本次畅聊已结束');
    expect(dividers['user-2']?.detail).toMatch(/^以下按轻量模型，每轮 15 星尘 · 下次畅聊：/);
  });

  it('falls back to a neutral line when the zone is open (user switched by hand)', () => {
    const open: PublicFreeZone = {
      state: 'open',
      ends_at: '2026-11-27T03:00:00+08:00',
      ...base,
      access: { ...access, via: 'vip_weekly', audience: 'vip' },
    };
    expect(freeZoneSwitchDividers(messages, catalog(open), now)['user-2']).toEqual({
      title: null,
      detail: '以下改用轻量模型，每轮 15 星尘',
    });
  });

  it('adds nothing without a free-to-paid change', () => {
    const paidOnly = [message(1, 'user'), message(1, 'assistant', 15), message(2, 'assistant')];
    expect(freeZoneSwitchDividers(paidOnly, catalog(null), now)).toEqual({});
  });
});

describe('free zone copy', () => {
  it('shows remaining time for trial and welcome windows', () => {
    const trial: PublicFreeZone = {
      state: 'open',
      ends_at: '2026-11-27T09:00:00+08:00',
      ...base,
      access: { ...access, via: 'trial', audience: 'trial' },
    };
    expect(freeZoneStatusText(trial, now)).toBe('新人体验 · 剩 2 天');
    expect(remainingText('2026-11-25T17:00:00+08:00', now)).toBe('剩 5 小时');
  });

  it('writes the audience rules before the operator notes', () => {
    const vipOnly: PublicFreeZone = {
      state: 'vip_only',
      vip_day: {
        open: false,
        starts_at: '2026-11-26T12:00:00+08:00',
        ends_at: '2026-11-27T03:00:00+08:00',
      },
      ...base,
      access,
    };
    expect(freeZoneStatusText(vipOnly, now)).toBe('VIP 专享');
    expect(freeZoneRulesText(vipOnly)).toBe(
      '开通 VIP：立享 5 天免费畅聊，之后每周四畅聊。\n免费模型会定期更换'
    );
    expect(freeZoneRulesText({ ...vipOnly, access: { ...access, audience: 'vip' } })).toContain(
      '每周四 12:00 至次日 03:00畅聊'
    );
    expect(freeZoneBoundaryDelay(vipOnly, now)).toBe(24 * 60 * 60 * 1000);
  });
});

describe('VIP card free chat terms', () => {
  const vipOnly: PublicFreeZone = {
    state: 'vip_only',
    vip_day: {
      open: false,
      starts_at: '2026-11-26T12:00:00+08:00',
      ends_at: '2026-11-27T03:00:00+08:00',
    },
    ...base,
    access,
  };

  it('shows the welcome days and weekly day for non-members', () => {
    expect(vipFreeChatTerms(vipOnly, now)).toEqual({
      welcomeDays: 5,
      weekday: '周四',
      memberStatus: '每周四',
    });
  });

  it('shows what a member has right now', () => {
    const vip = { ...access, audience: 'vip' as const };
    const welcome: PublicFreeZone = {
      state: 'open',
      ends_at: '2026-11-28T12:00:00+08:00',
      ...base,
      access: { ...vip, via: 'vip_welcome' },
    };
    expect(vipFreeChatTerms(welcome, now)?.memberStatus).toBe('开通礼 · 剩 3 天');
    const waiting: PublicFreeZone = {
      state: 'vip_waiting',
      starts_at: '2026-11-26T12:00:00+08:00',
      ...base,
      access: vip,
    };
    // 钟点按手机本地时区写，和运行环境的时区有关
    expect(vipFreeChatTerms(waiting, now)?.memberStatus).toBe(
      `${formatFreeZoneTime(waiting.starts_at, now)} 开始`
    );
  });

  it('hides during the all-users welfare period or without access rules', () => {
    const welfare: PublicFreeZone = {
      state: 'open',
      ends_at: '2026-11-28T12:00:00+08:00',
      ...base,
      access: { ...access, via: 'welfare', audience: 'everyone' },
    };
    expect(vipFreeChatTerms(welfare, now)).toBeNull();
    expect(vipFreeChatTerms({ state: 'no_models', ...base }, now)).toBeNull();
    expect(vipFreeChatTerms(null, now)).toBeNull();
  });
});

describe('daily limit copy', () => {
  const model = {
    id: 'free-gemini',
    display_name: 'Gemini 3.8 Flash',
    tagline: '',
    benchmark_tier: 'standard' as const,
    original_credits: 33,
    limited: true,
  };
  const later = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();
  const earlier = new Date(now.getTime() - 60 * 1000).toISOString();

  it('drops the "unlimited" claim only when some model has a limit', () => {
    const zone = { state: 'no_models', ...base, models: [model] } as PublicFreeZone;
    expect(freeZoneHasTurnLimits(zone)).toBe(true);
    expect(freeZoneHasTurnLimits({ ...zone, models: [{ ...model, limited: false }] })).toBe(false);
    // 旧后端不返回 limited
    expect(freeZoneHasTurnLimits({ ...zone, models: [{ ...model, limited: undefined }] })).toBe(
      false
    );
  });

  it('treats a model as used up only until its reset time', () => {
    expect(freeZoneModelResetsAt({ ...model, limit_resets_at: later }, now)).toBe(later);
    expect(freeZoneModelResetsAt({ ...model, limit_resets_at: earlier }, now)).toBeNull();
    expect(freeZoneModelResetsAt({ ...model, limit_resets_at: null }, now)).toBeNull();
    expect(freeZoneLimitHint({ ...model, limit_resets_at: later }, now)).toMatch(
      /^「Gemini 3\.8 Flash」的免费次数用完了，.+ 恢复，先换一个吧$/
    );
  });

  it('writes the switch notice for another free model or a paid one', () => {
    const item = {
      from_name: 'Gemini 3.8 Flash',
      to_name: 'Gemini 3.1 Flash Lite',
      resets_at: later,
    };
    expect(freeZoneSwitchNoticeText({ ...item, to_paid: false }, now)).toMatch(
      /^「Gemini 3\.8 Flash」的免费次数用完了，已换成「Gemini 3\.1 Flash Lite」继续畅聊，.+ 恢复$/
    );
    expect(
      freeZoneSwitchNoticeText(
        { ...item, to_name: 'DeepSeek', to_paid: true, resets_at: null },
        now
      )
    ).toBe('畅聊模型的免费次数都用完了，这轮起改用「DeepSeek」');
  });
});
