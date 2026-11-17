import { describe, expect, it } from 'vitest';
import type { ChatMessage, GetModelCatalogData, PublicFreeZone } from '@miniapp/shared';

import {
  freeZoneBoundaryDelay,
  freeZoneRulesText,
  freeZoneStatusText,
  freeZoneSwitchDividers,
  remainingText,
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
