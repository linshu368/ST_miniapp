/**
 * preset-apply.test.ts
 *
 * applyActivePreset() 是纯函数（原地修改传入的 oai_settings），直接测试。
 * 覆盖：
 *   1. 采样参数改名映射（temperature→temp_openai 等）
 *   2. 同名键映射（openai_max_tokens / prompts / prompt_order）
 *   3. payload 中缺失的键不覆盖 oai_settings 原值
 *   4. 指针缺失 / 格式不符 → 不应用
 *   5. 指针指向的预设不在列表 → 不应用（保留原值）
 *   6. 不修改传入的 preset.preset_payload（cloneDeep 隔离）
 *   7. resolveActivePresetId 解析
 */

import { describe, it, expect } from 'vitest';
import {
  applyActivePreset,
  resolveActivePresetId,
  PRESET_TO_OAI_SETTINGS,
} from '../preset-apply.js';
import type { PresetRow } from '../fetcher.js';

const PRESET_ID = 'c9db5957-844e-4707-a9f8-c8a54eee5260';

const makePreset = (overrides: Partial<PresetRow> = {}): PresetRow => ({
  id: PRESET_ID,
  display_name: '0616版预设TZ',
  is_default: true,
  preset_payload: {
    temperature: 1.24,
    frequency_penalty: 0,
    presence_penalty: 0.03,
    top_p: 0.9,
    top_k: 224,
    min_p: 0,
    openai_max_tokens: 3000,
    prompts: [{ identifier: 'main', content: 'x' }],
    prompt_order: [{ character_id: 100001, order: [] }],
    extensions: {},
  },
  ...overrides,
});

const makeOai = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  preset_settings_openai: `platform_${PRESET_ID}`,
  temp_openai: 0.84,
  freq_pen_openai: 0,
  pres_pen_openai: 0,
  top_p_openai: 1,
  top_k_openai: 0,
  min_p_openai: 0,
  openai_max_tokens: 550,
  prompts: [{ identifier: 'old' }],
  chat_completion_source: 'openrouter',
  ...overrides,
});

describe('applyActivePreset', () => {
  it('采样参数应按改名映射写入 oai_settings', () => {
    const oai = makeOai();
    const result = applyActivePreset(oai, [makePreset()]);

    expect(result.applied).toBe(true);
    expect(result.presetId).toBe(PRESET_ID);
    expect(oai.temp_openai).toBe(1.24);
    expect(oai.pres_pen_openai).toBe(0.03);
    expect(oai.top_p_openai).toBe(0.9);
    expect(oai.top_k_openai).toBe(224);
  });

  it('同名键（openai_max_tokens / prompts / prompt_order）应被覆盖', () => {
    const oai = makeOai();
    applyActivePreset(oai, [makePreset()]);

    expect(oai.openai_max_tokens).toBe(3000);
    expect(oai.prompts).toEqual([{ identifier: 'main', content: 'x' }]);
    expect(oai.prompt_order).toEqual([{ character_id: 100001, order: [] }]);
  });

  it('payload 未包含的键不应改动 oai_settings 原值', () => {
    const oai = makeOai();
    // 预设不含连接类字段，chat_completion_source 应保持原值（由 merger 后续强制覆写）
    applyActivePreset(oai, [makePreset()]);
    expect(oai.chat_completion_source).toBe('openrouter');
  });

  it('指针缺失时不应用', () => {
    const oai = makeOai({ preset_settings_openai: undefined });
    const result = applyActivePreset(oai, [makePreset()]);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no_pointer');
    expect(oai.temp_openai).toBe(0.84);
  });

  it('指针格式不符（无 platform_ 前缀）时不应用', () => {
    const oai = makeOai({ preset_settings_openai: 'Default' });
    const result = applyActivePreset(oai, [makePreset()]);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no_pointer');
  });

  it('指针指向的预设不在列表时不应用，保留原值', () => {
    const oai = makeOai({
      preset_settings_openai: 'platform_00000000-0000-4000-8000-000000000000',
    });
    const result = applyActivePreset(oai, [makePreset()]);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('preset_not_found');
    expect(result.presetId).toBe('00000000-0000-4000-8000-000000000000');
    expect(oai.temp_openai).toBe(0.84);
  });

  it('不应修改传入的 preset.preset_payload（引用隔离）', () => {
    const preset = makePreset();
    const oai = makeOai();
    applyActivePreset(oai, [preset]);

    // 修改结果里的 prompts 不应影响原 payload
    (oai.prompts as unknown[]).push({ identifier: 'injected' });
    expect((preset.preset_payload.prompts as unknown[]).length).toBe(1);
  });
});

describe('resolveActivePresetId', () => {
  it('解析 platform_<uuid> 指针', () => {
    expect(resolveActivePresetId(`platform_${PRESET_ID}`)).toBe(PRESET_ID);
  });

  it('非字符串 / 无前缀 / 空 → null', () => {
    expect(resolveActivePresetId(undefined)).toBeNull();
    expect(resolveActivePresetId('Default')).toBeNull();
    expect(resolveActivePresetId('platform_')).toBeNull();
  });
});

describe('PRESET_TO_OAI_SETTINGS 映射表', () => {
  it('8 个采样参数为改名映射，其余同名', () => {
    expect(PRESET_TO_OAI_SETTINGS.temperature).toBe('temp_openai');
    expect(PRESET_TO_OAI_SETTINGS.frequency_penalty).toBe('freq_pen_openai');
    expect(PRESET_TO_OAI_SETTINGS.presence_penalty).toBe('pres_pen_openai');
    expect(PRESET_TO_OAI_SETTINGS.top_p).toBe('top_p_openai');
    expect(PRESET_TO_OAI_SETTINGS.top_k).toBe('top_k_openai');
    expect(PRESET_TO_OAI_SETTINGS.top_a).toBe('top_a_openai');
    expect(PRESET_TO_OAI_SETTINGS.min_p).toBe('min_p_openai');
    expect(PRESET_TO_OAI_SETTINGS.repetition_penalty).toBe('repetition_penalty_openai');
    // 同名代表
    expect(PRESET_TO_OAI_SETTINGS.prompts).toBe('prompts');
    expect(PRESET_TO_OAI_SETTINGS.openai_max_tokens).toBe('openai_max_tokens');
  });

  it('不含连接/模型类字段（由 merger 强制控制）', () => {
    expect(PRESET_TO_OAI_SETTINGS.chat_completion_source).toBeUndefined();
    expect(PRESET_TO_OAI_SETTINGS.custom_url).toBeUndefined();
    expect(PRESET_TO_OAI_SETTINGS.custom_model).toBeUndefined();
    expect(PRESET_TO_OAI_SETTINGS.reverse_proxy).toBeUndefined();
    expect(PRESET_TO_OAI_SETTINGS.openrouter_model).toBeUndefined();
  });
});
