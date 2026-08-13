import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseInteractionModeBlocks,
  parseTemplate,
  parseWordCountTiers,
} from './platform-instructions.js';
import { resolveWordCountPromptValue } from './render-instructions.js';

const MIGRATION_071_PATH = new URL(
  '../../../../shared/migrations/071_engine_platform_instructions.sql',
  import.meta.url
);
const MIGRATION_076_PATH = new URL(
  '../../../../shared/migrations/076_engine_admin_platform_instructions.sql',
  import.meta.url
);

describe('runtime_config 解析', () => {
  it('模板优先取 text_value，兼容存在 value 里的写法', () => {
    expect(parseTemplate({ value: null, textValue: '模板', version: 1 })).toBe('模板');
    expect(parseTemplate({ value: '模板', textValue: null, version: 1 })).toBe('模板');
    expect(parseTemplate({ value: null, textValue: '  ', version: 1 })).toBeNull();
    expect(parseTemplate(undefined)).toBeNull();
  });

  it('选项模式块两块缺一不可', () => {
    expect(parseInteractionModeBlocks({ options_on: '开', options_off: '关' })).toEqual({
      optionsOn: '开',
      optionsOff: '关',
    });
    expect(parseInteractionModeBlocks({ options_on: '开' })).toBeNull();
    expect(parseInteractionModeBlocks('开')).toBeNull();
  });

  it('新 shape：id / ui_label / default_tier_id', () => {
    expect(
      parseWordCountTiers({
        tiers: [
          {
            id: '300-500',
            ui_label: '适中',
            prompt_value: '300-500',
            enabled: true,
            sort_order: 0,
          },
        ],
        default_tier_id: '300-500',
        layout: { columns: 4 },
      })
    ).toEqual({
      tiers: [
        {
          id: '300-500',
          uiLabel: '适中',
          promptValue: '300-500',
          enabled: true,
          sortOrder: 0,
        },
      ],
      defaultTierId: '300-500',
      layoutColumns: 4,
    });
  });

  it('旧 shape（label / default_value）仍可解析', () => {
    expect(
      parseWordCountTiers({
        tiers: [{ label: '300-500', prompt_value: '300-500' }],
        default_value: '300-500',
      })
    ).toEqual({
      tiers: [
        {
          id: '300-500',
          uiLabel: '300-500',
          promptValue: '300-500',
          enabled: true,
          sortOrder: 0,
        },
      ],
      defaultTierId: '300-500',
      layoutColumns: 4,
    });
  });

  it('档位表缺字段或为空时判为非法，交给调用方兜底', () => {
    expect(parseWordCountTiers({ tiers: [], default_tier_id: '300-500' })).toBeNull();
    expect(
      parseWordCountTiers({ tiers: [{ id: '300-500' }], default_tier_id: '300-500' })
    ).toBeNull();
    expect(parseWordCountTiers({ tiers: 'bad' })).toBeNull();
  });

  it('缺 default 时回落到首个启用档位 id', () => {
    expect(
      parseWordCountTiers({
        tiers: [{ id: '300-500', prompt_value: '300-500' }],
      })
    ).toEqual({
      tiers: [
        {
          id: '300-500',
          uiLabel: '300-500',
          promptValue: '300-500',
          enabled: true,
          sortOrder: 0,
        },
      ],
      defaultTierId: '300-500',
      layoutColumns: 4,
    });
  });
});

describe('migration 正文', () => {
  it('071 模板含三个占位符', () => {
    const sql = readFileSync(MIGRATION_071_PATH, 'utf8');
    expect(sql).toContain('{{WORD_COUNT}}');
    expect(sql).toContain('{{INTERACTION_MODE}}');
    expect(sql).toContain('{{USER_CUSTOM_INSTRUCTIONS}}');
  });

  it('076 把档位表升到可增删 shape，且默认档可命中', () => {
    const sql = readFileSync(MIGRATION_076_PATH, 'utf8');
    expect(sql).toContain('default_tier_id');
    expect(sql).toContain('ui_label');
    expect(sql).toContain("'system_instructions'");
    expect(sql).toContain("'pref_word_count_tiers'");

    const tiersConfig = parseWordCountTiers({
      tiers: [
        { id: '100-300', ui_label: '简短', prompt_value: '100-300', enabled: true, sort_order: 0 },
        { id: '300-500', ui_label: '适中', prompt_value: '300-500', enabled: true, sort_order: 1 },
        { id: '500-800', ui_label: '详细', prompt_value: '500-800', enabled: true, sort_order: 2 },
        { id: '800+', ui_label: '长篇', prompt_value: '800以上', enabled: true, sort_order: 3 },
      ],
      default_tier_id: '300-500',
      layout: { columns: 4 },
    });
    expect(tiersConfig).not.toBeNull();
    if (!tiersConfig) return;

    expect(resolveWordCountPromptValue('100-300', tiersConfig)).toBe('100-300');
    expect(resolveWordCountPromptValue('800+', tiersConfig)).toBe('800以上');
    expect(tiersConfig.tiers.map((tier) => tier.id)).toContain(tiersConfig.defaultTierId);
  });
});
