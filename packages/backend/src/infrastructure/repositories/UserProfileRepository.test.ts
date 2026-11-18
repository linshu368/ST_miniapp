import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserProfileRepository, type UserProfile } from './UserProfileRepository.js';
import { MiniappUserSettingsRepository } from './MiniappUserSettingsRepository.js';
import {
  composeSettingsRow,
  splitProfileFields,
  type UserPreferencesRow,
} from './user-settings-model.js';

// 记录调用顺序：getOrCreate 必须先刷新资料、再建偏好行（建行时数据库从 users 带资料）。
const calls = vi.hoisted(() => [] as string[]);
const state = vi.hoisted(() => ({
  rpcResult: { data: null as unknown, error: null as unknown },
  preferences: null as Record<string, unknown> | null,
}));

vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: () => ({
    rpc: (name: string, args: Record<string, unknown>) => ({
      abortSignal: async () => {
        calls.push(`rpc:${name}:${JSON.stringify(args)}`);
        return state.rpcResult;
      },
    }),
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => {
          calls.push(`read:${table}`);
          return { data: state.preferences, error: null };
        },
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              calls.push(`insert:${table}`);
              state.preferences = { ...preferences(), ...row };
              return { data: state.preferences, error: null };
            },
          }),
        }),
      };
      return query;
    },
  }),
}));

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    tg_username: 'tg',
    tg_first_name: 'First',
    tg_last_name: null,
    tg_avatar_url: null,
    display_name: null,
    custom_avatar_url: null,
    updated_at: '2026-11-17T10:00:00.000Z',
    ...overrides,
  };
}

function preferences(overrides: Partial<UserPreferencesRow> = {}): UserPreferencesRow {
  return {
    user_id: 'u1',
    pref_word_count: null,
    pref_show_options: true,
    pref_show_status: true,
    pref_show_memory: true,
    pref_reply_styles: {},
    pref_drive_mode: null,
    pref_custom_instructions: null,
    selected_model_id: null,
    pref_voice_id: null,
    pref_voice_playback_rate: 1,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-17T09:00:00.000Z',
    ...overrides,
  };
}

describe('user profile split (db reorg 3b-2)', () => {
  beforeEach(() => {
    calls.length = 0;
    state.rpcResult = { data: profile(), error: null };
    state.preferences = null;
  });

  it('refreshes Telegram data with nulls for missing fields', async () => {
    await new UserProfileRepository().refreshTelegram('u1', { id: 1, first_name: 'First' });
    expect(calls).toEqual([
      'rpc:refresh_user_profile:{"p_user_id":"u1","p_tg_username":null,"p_tg_first_name":"First","p_tg_last_name":null,"p_tg_avatar_url":null}',
    ]);
  });

  it('fails when the profile refresh fails or the user is missing', async () => {
    state.rpcResult = { data: null, error: { message: 'down' } };
    await expect(
      new UserProfileRepository().refreshTelegram('u1', { id: 1, first_name: 'First' })
    ).rejects.toThrow('刷新 Telegram 用户信息失败');
    state.rpcResult = { data: null, error: null };
    await expect(
      new UserProfileRepository().refreshTelegram('u1', { id: 1, first_name: 'First' })
    ).rejects.toThrow('用户不存在');
  });

  it('getOrCreate refreshes the profile before creating the preference row', async () => {
    const row = await new MiniappUserSettingsRepository().getOrCreate('u1', {
      id: 1,
      first_name: 'First',
    });
    expect(calls.map((call) => call.split(':').slice(0, 2).join(':'))).toEqual([
      'rpc:refresh_user_profile',
      'read:user_preferences',
      'insert:user_preferences',
    ]);
    expect(row).toMatchObject({ user_id: 'u1', tg_first_name: 'First', pref_show_options: true });
  });

  it('composes the later updated_at and tolerates a missing profile', () => {
    expect(composeSettingsRow(preferences(), profile()).updated_at).toBe(
      '2026-11-17T10:00:00.000Z'
    );
    expect(
      composeSettingsRow(preferences({ updated_at: '2026-11-17T11:00:00.000Z' }), profile())
        .updated_at
    ).toBe('2026-11-17T11:00:00.000Z');
    expect(composeSettingsRow(preferences(), null)).toMatchObject({
      display_name: null,
      tg_first_name: null,
      updated_at: '2026-11-17T09:00:00.000Z',
    });
  });

  it('routes display name and avatar to the profile and keeps the rest as preferences', () => {
    expect(
      splitProfileFields({
        display_name: '昵称',
        custom_avatar_url: null,
        pref_word_count: '300-500',
      })
    ).toEqual({
      profile: { display_name: '昵称', custom_avatar_url: null },
      preferences: { pref_word_count: '300-500' },
    });
  });
});
