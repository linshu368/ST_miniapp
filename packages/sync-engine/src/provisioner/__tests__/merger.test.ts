/**
 * merger.test.ts
 *
 * mergeSettings() 是纯函数（无 IO / 无网络），直接测试，无需 mock。
 * 覆盖场景：
 *   1. 新用户（B=null）→ 完全用 A 默认值
 *   2. 老用户（B 有记录）→ 白名单键被 B 覆盖
 *   3. B 中存在非白名单键 → 不被 merge 进结果
 *   4. character_ref 有效 → 不触发兜底
 *   5. character_ref 失效 → 触发兜底，回退到默认卡
 *   6. character_ref 失效 + 无默认卡 → 不崩溃，hadInvalidRef=true
 *   7. character_ref 格式不合法 → 触发兜底
 */

import { describe, it, expect } from 'vitest';
import { mergeSettings } from '../merger.js';
import type { CharacterRow, PlatformSettingsRow, UserSettingsRow } from '../fetcher.js';

// ─── 测试固件 ──────────────────────────────────────────────────────────────────

const CHAR_UUID_DEFAULT = '11111111-1111-4111-8111-000000000001';
const CHAR_UUID_SECOND = '22222222-2222-4222-8222-000000000002';

const makeDefaultChar = (id = CHAR_UUID_DEFAULT): CharacterRow => ({
  id,
  name: '第七开发部',
  is_default: true,
  is_published: true,
  is_active: true,
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
});

const makePlatformSettings = (
  overrides: Partial<PlatformSettingsRow> = {}
): PlatformSettingsRow => ({
  platform_version: 1,
  settings_jsonb: {
    active_character: `platform_${CHAR_UUID_DEFAULT}.png`,
    'oai_settings.prompts': [],
    theme: 'dark', // 非白名单字段
    fontSize: 14, // 非白名单字段
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
    active_character: `platform_${CHAR_UUID_DEFAULT}.png`,
    'oai_settings.prompts': [{ enabled: false }],
  },
  based_on_platform_version: 1,
  ...overrides,
});

// ─── 测试套件 ──────────────────────────────────────────────────────────────────

describe('mergeSettings', () => {
  // ── 场景 1：新用户，B=null ──────────────────────────────────────────────────
  it('新用户（B=null）应完全使用 A 默认值', () => {
    const platform = makePlatformSettings();
    const defaultChar = makeDefaultChar();
    const availableIds = [CHAR_UUID_DEFAULT];

    const result = mergeSettings(platform, null, availableIds, defaultChar);

    expect(result.hadInvalidRef).toBe(false);
    expect(result.settings['active_character']).toBe(`platform_${CHAR_UUID_DEFAULT}.png`);
    expect(result.settings['theme']).toBe('dark');
    expect(result.settings['fontSize']).toBe(14);
  });

  // ── 场景 2：老用户，白名单键被 B 覆盖 ────────────────────────────────────
  it('老用户白名单字段（oai_settings.prompts）应被 B 的值覆盖', () => {
    const platform = makePlatformSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_DEFAULT}.png`,
        'oai_settings.prompts': [{ enabled: true }],
        theme: 'dark',
      },
    });
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_DEFAULT}.png`,
        'oai_settings.prompts': [{ enabled: false, custom: true }],
      },
    });
    const availableIds = [CHAR_UUID_DEFAULT];

    const result = mergeSettings(platform, userSettings, availableIds, makeDefaultChar());

    // B 覆盖了 oai_settings.prompts
    expect(result.settings['oai_settings.prompts']).toEqual([{ enabled: false, custom: true }]);
    // 非白名单字段保持 A 的值
    expect(result.settings['theme']).toBe('dark');
  });

  // ── 场景 3：B 中有非白名单键，不应被 merge ───────────────────────────────
  it('B 中的非白名单键不应出现在 merge 结果中（已过滤）', () => {
    const platform = makePlatformSettings();
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_DEFAULT}.png`,
        'oai_settings.prompts': [],
        fontSize: 20, // 非白名单，B 中有但不应 merge
        secretField: 'hack', // 非白名单
      },
    });
    const availableIds = [CHAR_UUID_DEFAULT];

    const result = mergeSettings(platform, userSettings, availableIds, makeDefaultChar());

    // B 的非白名单字段不影响结果（结果来自 A 的 14）
    expect(result.settings['fontSize']).toBe(14);
    expect(result.settings['secretField']).toBeUndefined();
  });

  // ── 场景 4：character_ref 有效，不触发兜底 ───────────────────────────────
  it('character_ref 有效时 hadInvalidRef=false', () => {
    const platform = makePlatformSettings();
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: `platform_${CHAR_UUID_SECOND}.png`, // 指向第二张卡
      },
    });
    // 第二张卡已在 available 列表中
    const availableIds = [CHAR_UUID_DEFAULT, CHAR_UUID_SECOND];

    const result = mergeSettings(platform, userSettings, availableIds, makeDefaultChar());

    expect(result.hadInvalidRef).toBe(false);
    expect(result.settings['active_character']).toBe(`platform_${CHAR_UUID_SECOND}.png`);
  });

  // ── 场景 5：character_ref 失效，回退到默认卡 ─────────────────────────────
  it('character_ref 指向不存在的卡时应回退到默认卡', () => {
    const MISSING_UUID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const platform = makePlatformSettings();
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: `platform_${MISSING_UUID}.png`, // 这张卡没有下发
      },
    });
    const availableIds = [CHAR_UUID_DEFAULT]; // 不包含 MISSING_UUID

    const result = mergeSettings(platform, userSettings, availableIds, makeDefaultChar());

    expect(result.hadInvalidRef).toBe(true);
    expect(result.invalidRefValue).toBe(`platform_${MISSING_UUID}.png`);
    // 回退到默认卡
    expect(result.settings['active_character']).toBe(`platform_${CHAR_UUID_DEFAULT}.png`);
  });

  // ── 场景 6：character_ref 失效 + 无默认卡 ───────────────────────────────
  it('character_ref 失效且无默认卡时不崩溃，hadInvalidRef=true，字段保持失效值', () => {
    const MISSING_UUID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const platform = makePlatformSettings();
    const userSettings = makeUserSettings({
      settings_jsonb: { active_character: `platform_${MISSING_UUID}.png` },
    });

    // 不传默认卡
    const result = mergeSettings(platform, userSettings, [], undefined);

    expect(result.hadInvalidRef).toBe(true);
    // 没有兜底卡，字段仍为失效值（ST 可能会自行处理）
    expect(result.settings['active_character']).toBe(`platform_${MISSING_UUID}.png`);
  });

  // ── 场景 7：character_ref 格式不合法 ────────────────────────────────────
  it('active_character 不符合 platform_<uuid>.png 格式时应触发兜底', () => {
    const platform = makePlatformSettings();
    const userSettings = makeUserSettings({
      settings_jsonb: {
        active_character: '../../etc/passwd', // 非法值
      },
    });
    const availableIds = [CHAR_UUID_DEFAULT];

    const result = mergeSettings(platform, userSettings, availableIds, makeDefaultChar());

    expect(result.hadInvalidRef).toBe(true);
    expect(result.settings['active_character']).toBe(`platform_${CHAR_UUID_DEFAULT}.png`);
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

    mergeSettings(platform, userSettings, [CHAR_UUID_DEFAULT, CHAR_UUID_SECOND], makeDefaultChar());

    // platformSettings 原始对象不应被修改
    expect(platform.settings_jsonb['active_character']).toBe(originalValue);
  });
});
