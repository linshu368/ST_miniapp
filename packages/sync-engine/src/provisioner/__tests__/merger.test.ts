/**
 * merger.test.ts
 *
 * mergeSettings() 是纯函数（无 IO / 无网络），直接测试，无需 mock。
 * 覆盖场景：
 *   1. 新用户（B=null）→ 完全用 A 默认值
 *   2. 老用户（B 有记录）→ 白名单键被 B 覆盖
 *   3. B 中存在非白名单键 → 不被 merge 进结果
 *   4. character_ref 有效 → 不触发兜底
 *   5. character_ref 失效 → 触发兜底，回退到系统兜底卡
 *   6. character_ref 失效 + 无兜底卡 → 不崩溃，hadInvalidRef=true
 *   7. character_ref 格式不合法 → 触发兜底
 */

import { describe, it, expect } from 'vitest';
import { mergeSettings, PLATFORM_DISABLED_EXTENSIONS } from '../merger.js';
import type { PlatformSettingsRow, UserSettingsRow, PresetRow } from '../fetcher.js';

// ─── 测试固件 ──────────────────────────────────────────────────────────────────

const CHAR_UUID_FALLBACK = '11111111-1111-4111-8111-000000000001';
const CHAR_UUID_SECOND = '22222222-2222-4222-8222-000000000002';
const LLM_PROXY_URL = 'http://localhost:3001/api/platform/llm-proxy/v1';

const makePlatformSettings = (
  overrides: Partial<PlatformSettingsRow> = {}
): PlatformSettingsRow => ({
  platform_version: 1,
  settings_jsonb: {
    active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
    'oai_settings.prompts': [],
    theme: 'dark',
    fontSize: 14,
  },
  writable_paths: [
    { path: 'active_character', transform: 'character_ref' },
    { path: 'oai_settings.prompts', transform: 'passthrough' },
  ],
  ...overrides,
});

const makeUserSettings = (overrides: Partial<UserSettingsRow> = {}): UserSettingsRow => ({
  user_revision: 1,
  settings_jsonb: {
    active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
    'oai_settings.prompts': [{ enabled: false }],
  },
  based_on_platform_version: 1,
  ...overrides,
});

const mergeSettingsForTest = (
  platformSettings: PlatformSettingsRow,
  userSettings: UserSettingsRow | null,
  availableCharIds: string[],
  fallbackCharacterId: string | undefined
) =>
  mergeSettings(
    platformSettings,
    userSettings,
    [],
    availableCharIds,
    fallbackCharacterId,
    LLM_PROXY_URL
  );

// ─── 测试套件 ──────────────────────────────────────────────────────────────────

describe('mergeSettings', () => {
  // ── 场景 1：新用户，B=null ──────────────────────────────────────────────────
  it('新用户（B=null）应完全使用 A 默认值', () => {
    const platform = makePlatformSettings();
    const availableIds = [CHAR_UUID_FALLBACK];

    const result = mergeSettingsForTest(platform, null, availableIds, CHAR_UUID_FALLBACK);

    expect(result.hadInvalidRef).toBe(false);
    expect(result.settings['active_character']).toBeNull();
    expect(result.settings['active_group']).toBeNull();
    expect(result.settings['theme']).toBe('dark');
    expect(result.settings['fontSize']).toBe(14);
  });

  // ── 场景 2：老用户，白名单键被 B 覆盖 ────────────────────────────────────
  it('老用户白名单字段（oai_settings.prompts）应被 B 的值覆盖', () => {
    const platform = makePlatformSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
        'oai_settings.prompts': [{ enabled: true }],
        theme: 'dark',
      },
    });
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
        'oai_settings.prompts': [{ enabled: false, custom: true }],
      },
    });
    const availableIds = [CHAR_UUID_FALLBACK];

    const result = mergeSettingsForTest(platform, userSettings, availableIds, CHAR_UUID_FALLBACK);

    expect(result.settings['oai_settings.prompts']).toEqual([{ enabled: false, custom: true }]);
    expect(result.settings['theme']).toBe('dark');
  });

  // ── 场景 3：B 中有非白名单键，不应被 merge ───────────────────────────────
  it('B 中的非白名单键不应出现在 merge 结果中（已过滤）', () => {
    const platform = makePlatformSettings();
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
        'oai_settings.prompts': [],
        fontSize: 20,
        secretField: 'hack',
      },
    });
    const availableIds = [CHAR_UUID_FALLBACK];

    const result = mergeSettingsForTest(platform, userSettings, availableIds, CHAR_UUID_FALLBACK);

    expect(result.settings['fontSize']).toBe(14);
    expect(result.settings['secretField']).toBeUndefined();
  });

  // ── 场景 4：character_ref 有效，不触发兜底 ───────────────────────────────
  it('character_ref 有效时 hadInvalidRef=false', () => {
    const platform = makePlatformSettings();
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_SECOND}.png`,
      },
    });
    const availableIds = [CHAR_UUID_FALLBACK, CHAR_UUID_SECOND];

    const result = mergeSettingsForTest(platform, userSettings, availableIds, CHAR_UUID_FALLBACK);

    expect(result.hadInvalidRef).toBe(false);
    expect(result.settings['active_character']).toBeNull();
  });

  // ── 场景 5：character_ref 失效，回退到系统兜底卡 ─────────────────────────
  it('character_ref 指向不存在的卡时应回退到系统兜底卡', () => {
    const MISSING_UUID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const platform = makePlatformSettings();
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: `platform_${MISSING_UUID}.png`,
      },
    });
    const availableIds = [CHAR_UUID_FALLBACK];

    const result = mergeSettingsForTest(platform, userSettings, availableIds, CHAR_UUID_FALLBACK);

    expect(result.hadInvalidRef).toBe(true);
    expect(result.invalidRefValue).toBe(`platform_${MISSING_UUID}.png`);
    expect(result.settings['active_character']).toBeNull();
  });

  // ── 场景 6：character_ref 失效 + 无兜底卡 ───────────────────────────────
  it('character_ref 失效且无兜底卡时不崩溃，hadInvalidRef=true，字段保持失效值', () => {
    const MISSING_UUID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const platform = makePlatformSettings();
    const userSettings = makeUserSettings({
      settings_jsonb: { active_character: `platform_${MISSING_UUID}.png` },
    });

    const result = mergeSettingsForTest(platform, userSettings, [], undefined);

    expect(result.hadInvalidRef).toBe(true);
    expect(result.settings['active_character']).toBeNull();
  });

  // ── 场景 7：character_ref 格式不合法 ────────────────────────────────────
  it('active_character 不符合 platform_<uuid>.png 格式时应触发兜底', () => {
    const platform = makePlatformSettings();
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: '../../etc/passwd',
      },
    });
    const availableIds = [CHAR_UUID_FALLBACK];

    const result = mergeSettingsForTest(platform, userSettings, availableIds, CHAR_UUID_FALLBACK);

    expect(result.hadInvalidRef).toBe(true);
    expect(result.settings['active_character']).toBeNull();
  });

  // ── 场景 9：强制平台 LLM 代理链路（main_api/custom 源/兜底模型）─────────
  it('应强制 main_api=openai、custom 源与代理地址，custom_model 缺省时回退默认模型', () => {
    const platform = makePlatformSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
        'oai_settings.prompts': [],
        main_api: 'koboldhorde',
      },
    });
    const availableIds = [CHAR_UUID_FALLBACK];

    const result = mergeSettingsForTest(platform, null, availableIds, CHAR_UUID_FALLBACK);
    const oai = result.settings['oai_settings'] as Record<string, unknown>;

    expect(result.settings['main_api']).toBe('openai');
    expect(oai['chat_completion_source']).toBe('custom');
    expect(oai['custom_url']).toBe(LLM_PROXY_URL);
    expect(oai['custom_model']).toBe('anthropic/claude-sonnet-4.5');
  });

  it('已配置的 custom_model 不应被兜底默认值覆盖', () => {
    const platform = makePlatformSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
        'oai_settings.prompts': [],
        oai_settings: { custom_model: 'anthropic/claude-sonnet-4' },
      },
    });

    const result = mergeSettingsForTest(platform, null, [CHAR_UUID_FALLBACK], CHAR_UUID_FALLBACK);
    const oai = result.settings['oai_settings'] as Record<string, unknown>;

    expect(oai['custom_model']).toBe('anthropic/claude-sonnet-4');
  });

  // ── 场景 10：按指针应用预设到 oai_settings（B 方案核心）────────────────────
  it('应按 oai_settings.preset_settings_openai 指针把预设参数应用进 oai_settings', () => {
    const PRESET_ID = 'c9db5957-844e-4707-a9f8-c8a54eee5260';
    const platform = makePlatformSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
        oai_settings: {
          preset_settings_openai: `platform_${PRESET_ID}`,
          temp_openai: 0.84,
          openai_max_tokens: 550,
          prompts: [{ identifier: 'old' }],
        },
      },
    });
    const presets: PresetRow[] = [
      {
        id: PRESET_ID,
        display_name: '0616',
        is_default: true,
        preset_payload: {
          temperature: 1.24,
          openai_max_tokens: 3000,
          prompts: [{ identifier: 'main' }, { identifier: 'nsfw' }],
        },
      },
    ];

    const result = mergeSettings(
      platform,
      null,
      presets,
      [CHAR_UUID_FALLBACK],
      CHAR_UUID_FALLBACK,
      LLM_PROXY_URL
    );
    const oai = result.settings['oai_settings'] as Record<string, unknown>;

    expect(result.presetApplied).toBe(true);
    expect(result.appliedPresetId).toBe(PRESET_ID);
    expect(oai['temp_openai']).toBe(1.24);
    expect(oai['openai_max_tokens']).toBe(3000);
    expect(oai['prompts']).toEqual([{ identifier: 'main' }, { identifier: 'nsfw' }]);
  });

  // ── 场景 11：预设先应用，B 白名单 oai_settings.prompts 仍覆盖预设 ──────────
  it('B 的 writable_paths（oai_settings.prompts）应覆盖预设应用后的 prompts', () => {
    const PRESET_ID = 'c9db5957-844e-4707-a9f8-c8a54eee5260';
    const platform = makePlatformSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
        oai_settings: {
          preset_settings_openai: `platform_${PRESET_ID}`,
          temp_openai: 0.84,
          prompts: [{ identifier: 'old' }],
        },
      },
      writable_paths: [
        { path: 'active_character', transform: 'character_ref' },
        { path: 'oai_settings.prompts', transform: 'passthrough' },
      ],
    });
    const presets: PresetRow[] = [
      {
        id: PRESET_ID,
        display_name: '0616',
        is_default: true,
        preset_payload: {
          temperature: 1.24,
          prompts: [{ identifier: 'preset' }],
        },
      },
    ];
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
        oai_settings: { prompts: [{ identifier: 'user-custom' }] },
      },
    });

    const result = mergeSettings(
      platform,
      userSettings,
      presets,
      [CHAR_UUID_FALLBACK],
      CHAR_UUID_FALLBACK,
      LLM_PROXY_URL
    );
    const oai = result.settings['oai_settings'] as Record<string, unknown>;

    // 采样参数来自预设，但 prompts 被用户 B 覆盖
    expect(oai['temp_openai']).toBe(1.24);
    expect(oai['prompts']).toEqual([{ identifier: 'user-custom' }]);
  });

  // ── 场景 12：强制禁用平台无用扩展（冷启动优化 P0-#1）───────────────────────
  it('应把 PLATFORM_DISABLED_EXTENSIONS 写入 extension_settings.disabledExtensions', () => {
    const platform = makePlatformSettings();

    const result = mergeSettingsForTest(platform, null, [CHAR_UUID_FALLBACK], CHAR_UUID_FALLBACK);
    const extSettings = result.settings['extension_settings'] as Record<string, unknown>;

    expect(extSettings['disabledExtensions']).toEqual([...PLATFORM_DISABLED_EXTENSIONS]);
  });

  it('disabledExtensions 应与平台种子已有值取并集且去重', () => {
    const platform = makePlatformSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
        'oai_settings.prompts': [],
        extension_settings: {
          disabledExtensions: ['tts', 'third-party/some-legacy-ext'],
          memory: { source: 'main' },
        },
      },
    });

    const result = mergeSettingsForTest(platform, null, [CHAR_UUID_FALLBACK], CHAR_UUID_FALLBACK);
    const extSettings = result.settings['extension_settings'] as Record<string, unknown>;
    const disabled = extSettings['disabledExtensions'] as string[];

    // 种子里已有的保留（含第三方遗留项），新增项并入，tts 不重复
    expect(disabled).toContain('third-party/some-legacy-ext');
    for (const name of PLATFORM_DISABLED_EXTENSIONS) {
      expect(disabled).toContain(name);
    }
    expect(disabled.filter((x) => x === 'tts')).toHaveLength(1);
    // 其余 extension_settings 字段不受影响
    expect(extSettings['memory']).toEqual({ source: 'main' });
  });

  it('用户 B 段不能解禁平台强制禁用的扩展（disabledExtensions 不在 writable_paths）', () => {
    const platform = makePlatformSettings();
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
        'oai_settings.prompts': [],
        extension_settings: { disabledExtensions: [] },
      },
    });

    const result = mergeSettingsForTest(
      platform,
      userSettings,
      [CHAR_UUID_FALLBACK],
      CHAR_UUID_FALLBACK
    );
    const extSettings = result.settings['extension_settings'] as Record<string, unknown>;

    expect(extSettings['disabledExtensions']).toEqual([...PLATFORM_DISABLED_EXTENSIONS]);
  });

  // ── 场景 13：全量下线 Moonlit ─────────────────────────────────────────────
  it('应禁用 Moonlit 并清理平台种子中的主题残留', () => {
    const platform = makePlatformSettings({
      settings_jsonb: {
        extension_settings: {
          SillyTavernMoonlitEchoesTheme: { enabled: true },
        },
        power_user: {
          chat_display: 3,
          theme: 'Glimmer - by Rivelle',
        },
        background: { name: 'night-city-anime.jpg' },
      },
    });
    const result = mergeSettingsForTest(platform, null, [CHAR_UUID_FALLBACK], CHAR_UUID_FALLBACK);
    const extensions = result.settings['extension_settings'] as Record<string, unknown>;
    const powerUser = result.settings['power_user'] as Record<string, unknown>;

    expect(extensions['disabledExtensions']).toContain('third-party/MoonlitEchoesTheme');
    expect(extensions['SillyTavernMoonlitEchoesTheme']).toBeUndefined();
    expect(powerUser['theme']).toBeUndefined();
    expect(powerUser['chat_display']).toBe(0);
    expect(result.settings['background']).toBeUndefined();
  });

  // ── 场景 14：强制关闭消息 token 计数（P1-H2 瘦身）──────────────────────────
  it('应强制 power_user.message_token_count_enabled=false（覆盖种子里的 true）', () => {
    const platform = makePlatformSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
        'oai_settings.prompts': [],
        power_user: { message_token_count_enabled: true, personas: {} },
      },
    });

    const result = mergeSettingsForTest(platform, null, [CHAR_UUID_FALLBACK], CHAR_UUID_FALLBACK);
    const powerUser = result.settings['power_user'] as Record<string, unknown>;

    expect(powerUser['message_token_count_enabled']).toBe(false);
    expect(powerUser['personas']).toEqual({});
  });

  it('应强制关闭 ST boot 旧聊天自动恢复', () => {
    const platform = makePlatformSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_FALLBACK}.png`,
        power_user: { auto_load_chat: true },
      },
    });

    const result = mergeSettingsForTest(platform, null, [CHAR_UUID_FALLBACK], CHAR_UUID_FALLBACK);
    const powerUser = result.settings['power_user'] as Record<string, unknown>;

    expect(powerUser['auto_load_chat']).toBe(false);
    expect(result.settings['active_character']).toBeNull();
    expect(result.settings['active_group']).toBeNull();
  });

  // ── 场景 8：深拷贝，不修改原始对象 ──────────────────────────────────────
  it('mergeSettings 不应修改传入的 platformSettings 对象', () => {
    const platform = makePlatformSettings();
    const originalValue = platform.settings_jsonb['active_character'];
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_SECOND}.png`,
      },
    });

    mergeSettingsForTest(
      platform,
      userSettings,
      [CHAR_UUID_FALLBACK, CHAR_UUID_SECOND],
      CHAR_UUID_FALLBACK
    );

    expect(platform.settings_jsonb['active_character']).toBe(originalValue);
  });
});
