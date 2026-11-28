import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplyStylePreferences } from '@miniapp/shared';
import type { PlatformInstructionsSnapshot } from '../../features/engine/platform-instructions.js';
import {
  MiniappUserSettingsRepository,
  toUserSettings,
  type MiniappUserSettingsRow,
} from './MiniappUserSettingsRepository.js';

const database = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  read: vi.fn(),
  update: vi.fn(),
  instructions: vi.fn(),
}));
vi.mock('../../lib/supabase.js', () => ({ getDomainDb: () => database }));
vi.mock('../../features/engine/platform-instructions.js', () => ({
  fetchPlatformInstructions: database.instructions,
  toPublicWordCountTiersFromEngine: () => ({
    tiers: [{ id: '300-500', ui_label: '适中', sort_order: 0 }],
    default_tier_id: '300-500',
    layout: { columns: 4 },
  }),
}));

function initialRow(): MiniappUserSettingsRow {
  return {
    user_id: 'test-user',
    tg_username: null,
    tg_first_name: 'Test',
    tg_last_name: null,
    display_name: null,
    tg_avatar_url: null,
    custom_avatar_url: null,
    pref_word_count: null,
    pref_show_options: true,
    pref_show_status: true,
    pref_show_memory: true,
    pref_reply_styles: {},
    pref_drive_mode: null,
    pref_custom_instructions: 'existing preference',
    selected_model_id: null,
    pref_voice_id: null,
    pref_voice_playback_rate: 1,
    created_at: '2026-10-23T00:00:00Z',
    updated_at: '2026-10-23T00:00:00Z',
  };
}

let stored: MiniappUserSettingsRow;
let repository: MiniappUserSettingsRepository;
const telegramUser = { id: 1001, first_name: 'Test' };

beforeEach(() => {
  vi.restoreAllMocks();
  Object.values(database).forEach((mock) => mock.mockReset());
  stored = initialRow();
  database.instructions.mockResolvedValue({ instructions: { wordCountTiers: {} } });
  database.read.mockImplementation(async () => ({ data: { ...stored }, error: null }));
  database.update.mockImplementation((fields: Record<string, unknown>) => ({
    eq: async () => {
      Object.assign(stored, fields);
      return { error: null };
    },
  }));
  database.from.mockReturnValue({
    select: () => ({
      eq: () => ({
        maybeSingle: database.read,
        abortSignal: () => ({ maybeSingle: database.read }),
      }),
    }),
    update: database.update,
  });
  database.rpc.mockImplementation(
    (_name: string, args: { p_user_id: string; p_patch: ReplyStylePreferences }) => ({
      abortSignal: async () => {
        stored.pref_reply_styles = { ...stored.pref_reply_styles, ...args.p_patch };
        return { error: null };
      },
    })
  );
  repository = new MiniappUserSettingsRepository();
  vi.spyOn(repository, 'getOrCreate').mockImplementation(async () => ({ ...stored }));
});

describe('reply-style user preference persistence boundary', () => {
  it('reads config without depending on profile names or changing stored preferences', async () => {
    stored.selected_model_id = 'operator-model';
    stored.pref_show_memory = false;
    const before = structuredClone(stored);
    database.read.mockImplementationOnce(async () => ({ data: { ...stored }, error: null }));
    // An unrelated names read would remain unresolved and must not be started by this endpoint.
    database.read.mockImplementation(async () => new Promise(() => {}));
    expect(await repository.getGenerationConfig('test-user')).toMatchObject({
      selected_model_id: 'operator-model',
      pref_show_memory: false,
      pref_custom_instructions: 'existing preference',
    });
    expect(database.from.mock.calls.map((call) => call[0])).toEqual(['user_preferences']);
    expect(database.read).toHaveBeenCalledOnce();
    expect(database.update).not.toHaveBeenCalled();
    expect(database.rpc).not.toHaveBeenCalled();
    expect(stored).toEqual(before);
  });

  it('retains preference failure instead of returning default config', async () => {
    const failure = { message: 'preferences unavailable', code: '57014' };
    database.read.mockResolvedValueOnce({ data: null, error: failure });
    await expect(repository.getGenerationConfig('test-user')).rejects.toMatchObject({
      cause: failure,
    });
    expect(database.from.mock.calls.map((call) => call[0])).toEqual(['user_preferences']);
    expect(database.read).toHaveBeenCalledOnce();
    expect(database.update).not.toHaveBeenCalled();
  });

  it('retains platform instruction failure instead of inventing configuration', async () => {
    const error = new Error('platform instructions unavailable');
    database.instructions.mockRejectedValueOnce(error);
    await expect(repository.getGenerationConfig('test-user')).rejects.toBe(error);
    expect(database.from.mock.calls.map((call) => call[0])).toEqual(['user_preferences']);
    expect(database.update).not.toHaveBeenCalled();
    expect(database.rpc).not.toHaveBeenCalled();
  });

  it('reuses the turn instruction snapshot while still reading names once', async () => {
    const snapshot: PlatformInstructionsSnapshot = {
      degraded: false,
      instructions: {
        template: '',
        wordCountTiers: { tiers: [], defaultTierId: '300-500', layoutColumns: 4 },
        choiceRules: { on_first_two_turns: 'first', on_later_turns: 'later', off: 'off' },
        replyStyles: [],
        driveModes: null,
      },
    };
    const result = await repository.getGenerationContext('test-user', Promise.resolve(snapshot));
    expect(result.displayName).toBe('Test');
    expect(result.config.pref_word_count).toBe('300-500');
    expect(database.instructions).not.toHaveBeenCalled();
    expect(database.read).toHaveBeenCalledTimes(2);
  });

  it('freezes model, prompt preferences and persona in one read for the whole turn', async () => {
    stored.selected_model_id = 'operator-model';
    stored.display_name = '本轮昵称';
    stored.pref_word_count = 'retired-tier';
    stored.pref_show_options = false;
    const result = await repository.getGenerationContext('test-user');
    // 偏好与资料分在两张表：同一请求内各读一次，之后本轮不再读。
    expect(database.from.mock.calls.map((call) => call[0]).sort()).toEqual([
      'user_preferences',
      'users',
    ]);
    expect(database.read).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      displayName: '本轮昵称',
      config: {
        selected_model_id: 'operator-model',
        pref_word_count: '300-500',
        pref_show_options: false,
        pref_custom_instructions: 'existing preference',
      },
    });
  });

  it('uses existing defaults and persona fallback when neither preferences nor profile exist', async () => {
    database.read
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    expect(await repository.getGenerationContext('test-user')).toMatchObject({
      displayName: '你',
      config: { selected_model_id: null, pref_word_count: '300-500', pref_show_memory: true },
    });
    stored.display_name = null;
    stored.tg_first_name = 'Telegram name';
    expect((await repository.getGenerationContext('test-user')).displayName).toBe('Telegram name');
  });

  it('takes the persona from the profile even when no preference row exists yet', async () => {
    stored.display_name = '资料昵称';
    database.read.mockResolvedValueOnce({ data: null, error: null });
    expect(await repository.getGenerationContext('test-user')).toMatchObject({
      displayName: '资料昵称',
      config: { selected_model_id: null, pref_show_options: true },
    });
  });

  it('fails closed without retrying if preparation cannot read settings', async () => {
    database.read.mockResolvedValueOnce({ data: null, error: { message: 'unavailable' } });
    await expect(repository.getGenerationContext('test-user')).rejects.toThrow(
      '查询用户生成配置失败'
    );
    expect(database.read).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the profile read fails even if preferences were read', async () => {
    database.read
      .mockResolvedValueOnce({ data: { ...stored }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'profile unavailable' } });
    await expect(repository.getGenerationContext('test-user')).rejects.toThrow(
      '查询用户生成配置失败'
    );
  });

  it('defaults old/missing settings to an empty map without changing custom instructions', async () => {
    database.read.mockResolvedValueOnce({ data: null, error: null });
    expect(await repository.getGenerationConfig('test-user')).toMatchObject({
      pref_reply_styles: {},
    });
    Object.assign(stored, { pref_reply_styles: undefined });
    expect(toUserSettings(stored)).toMatchObject({
      pref_reply_styles: {},
      pref_custom_instructions: 'existing preference',
    });
  });

  it('keeps unrelated IDs and sends only the partial map to the atomic RPC', async () => {
    stored.pref_reply_styles = { 'style-existing': true };
    const result = await repository.patch('test-user', telegramUser, {
      pref_reply_styles: { 'style-retired': true },
      pref_custom_instructions: 'updated preference',
    });
    expect(database.rpc).toHaveBeenCalledWith('update_reply_style_preferences', {
      p_user_id: 'test-user',
      p_patch: { 'style-retired': true },
    });
    expect(database.update).toHaveBeenCalledOnce();
    expect(database.update.mock.calls[0]?.[0]).not.toHaveProperty('pref_reply_styles');
    expect(result.pref_reply_styles).toEqual({ 'style-existing': true, 'style-retired': true });
    expect(result.pref_custom_instructions).toBe('updated preference');
  });

  it('independent concurrent updates each use a partial RPC and do not send a replacement map', async () => {
    await Promise.all([
      repository.patch('test-user', telegramUser, { pref_reply_styles: { 'style-first': true } }),
      repository.patch('test-user', telegramUser, { pref_reply_styles: { 'style-second': false } }),
    ]);
    expect(database.rpc).toHaveBeenCalledTimes(2);
    expect(database.rpc.mock.calls.map((call) => call[1].p_patch)).toEqual([
      { 'style-first': true },
      { 'style-second': false },
    ]);
    expect(database.update).not.toHaveBeenCalled();
    expect(stored.pref_reply_styles).toEqual({ 'style-first': true, 'style-second': false });
  });

  it('an empty partial map is a no-op and malformed stored maps never escape the DTO', async () => {
    await repository.patch('test-user', telegramUser, { pref_reply_styles: {} });
    expect(database.rpc).not.toHaveBeenCalled();
    Object.assign(stored, { pref_reply_styles: { 'style-first': 'true' } });
    expect(await repository.getGenerationConfig('test-user')).toMatchObject({
      pref_reply_styles: {},
    });
    expect(toUserSettings(stored).pref_reply_styles).toEqual({});
  });

  it('RPC failure rejects without directly updating the map or pretending to save', async () => {
    database.rpc.mockReturnValue({
      abortSignal: async () => ({ error: { message: 'write failed' } }),
    });
    await expect(
      repository.patch('test-user', telegramUser, { pref_reply_styles: { 'style-first': true } })
    ).rejects.toThrow('原子更新回复风格偏好失败');
    expect(database.update).not.toHaveBeenCalled();
    expect(stored.pref_reply_styles).toEqual({});
  });
});
