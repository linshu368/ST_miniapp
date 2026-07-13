/**
 * provisioner.test.ts
 *
 * 对 provision() 主函数的集成测试，使用 vi.mock 隔离外部依赖：
 *   - Supabase（fetcher.ts / supabase.ts）
 *   - ST 文件系统（writer.ts）
 *   - ST API（st-user.ts）
 *
 * 测试重点：provision() 的编排逻辑是否正确
 *   1. 正常路径：新用户，一切成功
 *   2. 正常路径：老用户，增量补全（force=false）
 *   3. 异常路径：fetchProvisionData 抛错 → provision 抛 ProvisionError
 *   4. 异常路径：character PNG 全部缺失时，结果中 charactersMissing > 0
 *   5. 异常路径：character_ref 失效时，hadInvalidRef=true
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { ProvisionData } from '../fetcher.js';
import type { PlatformSettingsRow, UserSettingsRow } from '../fetcher.js';

// ─── Mock 声明（必须在 import 之前） ──────────────────────────────────────────

vi.mock('../fetcher.js', () => ({
  fetchProvisionData: vi.fn(),
  FetchError: class FetchError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'FetchError';
    }
  },
}));

vi.mock('../writer.js', () => ({
  DEFAULT_USER_AVATAR_FILENAME: '4d015fdd-7f82-482c-912d-466eaa826280.png',
  writeCharacters: vi.fn(async () => ({ written: [], skipped: [], missing: [] })),
  writePlatformAssets: vi.fn(() => ({ written: [], skipped: [] })),
  writePresets: vi.fn(() => ({ written: [], skipped: [] })),
  writeSettings: vi.fn(),
  writeSecrets: vi.fn(),
  ensureUserAvatar: vi.fn(),
}));

vi.mock('../st-user.js', () => ({
  ensureStUser: vi.fn(() => ({ created: true })),
  StUserError: class StUserError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'StUserError';
    }
  },
}));

vi.mock('../../lib/config.js', () => ({
  config: {
    ST_DATA_PATH: '/mock-st-data',
    CHARACTER_STORAGE_BUCKET: 'character-assets',
    SUPABASE_URL: 'https://mock.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'mock-service-role-key',
    ST_BASE_URL: 'http://localhost:8000',
    ST_ADMIN_USERNAME: 'admin',
    ST_ADMIN_PASSWORD: 'mock-admin-password',
    ST_USER_PASSWORD_SECRET: 'mock-secret-at-least-16',
    LLM_PROXY_URL: 'http://localhost:3001/api/platform/llm-proxy/v1',
  },
  loadConfig: vi.fn(),
}));

vi.mock('../../lib/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({
    schema: vi.fn(() => ({
      from: vi.fn(() => ({
        update: vi.fn(() => ({
          eq: vi.fn(() => ({ error: null })),
        })),
      })),
    })),
    from: vi.fn(() => ({
      update: vi.fn(() => ({
        eq: vi.fn(() => ({ error: null })),
      })),
    })),
  })),
}));

// ─── 在 mock 之后 import ───────────────────────────────────────────────────────
import { provision, ProvisionError } from '../index.js';
import * as fetcherMod from '../fetcher.js';
import * as writerMod from '../writer.js';
import * as stUserMod from '../st-user.js';

// ─── 测试固件 ──────────────────────────────────────────────────────────────────
const CHAR_UUID = '11111111-1111-4111-8111-000000000001';
const PRESET_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'user-0000-0000-0000-000000000001';

const mockChar = {
  id: CHAR_UUID,
  name: '第七开发部',
  enabled: true,
  sort_order: 0,
  description: null,
  personality: null,
  scenario: null,
  first_mes: null,
  mes_example: null,
  creator_notes: null,
  system_prompt: null,
  post_history_instructions: null,
  alternate_greetings: [],
  tags: [],
  character_book: null,
  extensions: {},
  creator: null,
  character_version: null,
  spec: null,
  spec_version: null,
};

const mockPlatformSettings: PlatformSettingsRow = {
  platform_version: 1,
  settings_jsonb: {
    active_character: `platform_${CHAR_UUID}.png`,
    theme: 'dark',
  },
  writable_paths: [
    { path: 'active_character', transform: 'character_ref' },
    { path: 'oai_settings.prompts', transform: 'passthrough' },
  ],
};

function makeProvisionData(userSettings: UserSettingsRow | null = null): ProvisionData {
  return {
    stHandle: 'tg_12345678',
    characters: [mockChar],
    presets: [{ id: PRESET_UUID, display_name: 'Default', preset_payload: {}, is_default: true }],
    platformSettings: mockPlatformSettings,
    apiConfig: null,
    userSettings,
    systemFallbackCharacterId: CHAR_UUID,
    userPersona: { name: '用户', avatarUrl: null },
    defaultLlmModel: 'anthropic/claude-sonnet-4.5',
  };
}

// ─── 测试套件 ──────────────────────────────────────────────────────────────────
describe('provision()', () => {
  const mockedFetch = fetcherMod.fetchProvisionData as unknown as MockInstance;
  const mockedWriteChars = writerMod.writeCharacters as unknown as MockInstance;
  const mockedWritePlatformAssets = writerMod.writePlatformAssets as unknown as MockInstance;
  const mockedWritePresets = writerMod.writePresets as unknown as MockInstance;
  const mockedWriteSettings = writerMod.writeSettings as unknown as MockInstance;
  const mockedEnsureAvatar = writerMod.ensureUserAvatar as unknown as MockInstance;
  const mockedEnsureUser = stUserMod.ensureStUser as unknown as MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    // 默认成功 mock
    mockedFetch.mockResolvedValue(makeProvisionData());
    mockedWriteChars.mockResolvedValue({ written: [CHAR_UUID], skipped: [], missing: [] });
    mockedWritePlatformAssets.mockReturnValue({
      written: ['themes/Glimmer - by Rivelle.json', 'backgrounds/night-city-anime.jpg'],
      skipped: [],
    });
    mockedWritePresets.mockReturnValue({ written: [PRESET_UUID], skipped: [] });
    mockedWriteSettings.mockReturnValue(undefined);
    mockedEnsureAvatar.mockResolvedValue('4d015fdd-7f82-482c-912d-466eaa826280.png');
    mockedEnsureUser.mockResolvedValue({ created: true });
  });

  // ── 场景 1：新用户正常路径 ────────────────────────────────────────────────
  it('新用户正常路径：返回正确的摘要信息', async () => {
    const result = await provision(USER_ID, { log: () => {} });

    expect(result.userId).toBe(USER_ID);
    expect(result.stHandle).toBe('tg_12345678');
    expect(result.charactersWritten).toBe(1);
    expect(result.charactersSkipped).toBe(0);
    expect(result.charactersMissing).toBe(0);
    expect(result.presetsWritten).toBe(1);
    expect(result.presetsSkipped).toBe(0);
    expect(result.hadInvalidRef).toBe(false);
    expect(result.alreadyInitialized).toBe(false); // 新用户
  });

  it('新用户正常路径：各写入函数被调用一次', async () => {
    await provision(USER_ID, { log: () => {} });

    expect(mockedEnsureUser).toHaveBeenCalledOnce();
    expect(mockedWriteChars).toHaveBeenCalledOnce();
    expect(mockedWritePlatformAssets).toHaveBeenCalledOnce();
    expect(mockedWritePresets).toHaveBeenCalledOnce();
    expect(mockedWriteSettings).toHaveBeenCalledOnce();
  });

  it('默认 persona：无 TG 名字/头像时注入默认名字和头像', async () => {
    await provision(USER_ID, { log: () => {} });

    expect(mockedEnsureAvatar).toHaveBeenCalledWith('tg_12345678', null, false);
    const [, merged] = mockedWriteSettings.mock.calls[0] as [
      string,
      { settings: Record<string, unknown> },
    ];

    expect(merged.settings['username']).toBe('用户');
    expect(merged.settings['name1']).toBe('用户');
    expect(merged.settings['active_character']).toBeNull();
    expect(merged.settings['active_group']).toBeNull();
    expect(merged.settings['user_avatar']).toBe('4d015fdd-7f82-482c-912d-466eaa826280.png');
    expect(merged.settings['power_user']).toEqual({
      chat_display: 3,
      theme: 'Glimmer - by Rivelle',
      personas: { '4d015fdd-7f82-482c-912d-466eaa826280.png': '用户' },
      persona_descriptions: {
        '4d015fdd-7f82-482c-912d-466eaa826280.png': { position: 0, description: '' },
      },
      // merger 强制项（P1-H2 瘦身）：关闭消息气泡 token 计数
      message_token_count_enabled: false,
    });
  });

  it('新用户正常路径：writeChars 以 force=false 调用', async () => {
    await provision(USER_ID, { force: false, log: () => {} });
    const [, , forceArg] = mockedWriteChars.mock.calls[0] as [unknown, unknown, boolean];
    expect(forceArg).toBe(false);
  });

  // ── 场景 2：老用户，增量补全（force=false）────────────────────────────────
  it('老用户（B 有记录）：alreadyInitialized=true', async () => {
    const userSettings: UserSettingsRow = {
      user_revision: 5,
      settings_jsonb: { active_character: `platform_${CHAR_UUID}.png` },
      based_on_platform_version: 1,
    };
    mockedFetch.mockResolvedValue(makeProvisionData(userSettings));

    const result = await provision(USER_ID, { log: () => {} });
    expect(result.alreadyInitialized).toBe(true);
  });

  it('force=true 时：writeChars 以 force=true 调用', async () => {
    await provision(USER_ID, { force: true, log: () => {} });
    const [, , forceArg] = mockedWriteChars.mock.calls[0] as [unknown, unknown, boolean];
    expect(forceArg).toBe(true);
  });

  // ── 场景 3：fetchProvisionData 抛错 ──────────────────────────────────────
  it('fetchProvisionData 抛错时 provision 应抛出 ProvisionError', async () => {
    mockedFetch.mockRejectedValue(new Error('Supabase connection refused'));

    await expect(provision(USER_ID, { log: () => {} })).rejects.toThrow(ProvisionError);
  });

  it('fetchProvisionData 抛错时错误信息包含原因', async () => {
    mockedFetch.mockRejectedValue(new Error('Supabase connection refused'));

    try {
      await provision(USER_ID, { log: () => {} });
    } catch (err) {
      expect(err).toBeInstanceOf(ProvisionError);
      expect((err as ProvisionError).message).toContain('拉取数据失败');
    }
  });

  // ── 场景 4：角色卡全部缺失（missing） ────────────────────────────────────
  it('角色卡 PNG 全部缺失时：charactersMissing > 0，但不抛错（流程继续）', async () => {
    mockedWriteChars.mockResolvedValue({ written: [], skipped: [], missing: [CHAR_UUID] });

    const result = await provision(USER_ID, { log: () => {} });

    expect(result.charactersMissing).toBe(1);
    expect(result.charactersWritten).toBe(0);
    // settings.json 仍然写入（流程不中断）
    expect(mockedWriteSettings).toHaveBeenCalledOnce();
  });

  // ── 场景 5：character_ref 失效（指向未下发的卡）────────────────────────
  it('character_ref 指向未下发的卡时：hadInvalidRef=true', async () => {
    const MISSING_UUID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    // 模拟 B 类记录中 active_character 指向一张没被下发的卡
    const userSettings: UserSettingsRow = {
      user_revision: 1,
      settings_jsonb: { active_character: `platform_${MISSING_UUID}.png` },
      based_on_platform_version: 1,
    };
    mockedFetch.mockResolvedValue(makeProvisionData(userSettings));
    // writer 返回：只写入了 CHAR_UUID，不包含 MISSING_UUID
    mockedWriteChars.mockResolvedValue({ written: [CHAR_UUID], skipped: [], missing: [] });

    const result = await provision(USER_ID, { log: () => {} });

    expect(result.hadInvalidRef).toBe(true);
    expect(result.invalidRefValue).toBe(`platform_${MISSING_UUID}.png`);
  });

  // ── 场景 6：ensureStUser 抛错 ─────────────────────────────────────────────
  it('ensureStUser 抛错时 provision 应抛出 ProvisionError', async () => {
    mockedEnsureUser.mockRejectedValue(new Error('ST server unreachable'));

    await expect(provision(USER_ID, { log: () => {} })).rejects.toThrow(ProvisionError);
  });
});
