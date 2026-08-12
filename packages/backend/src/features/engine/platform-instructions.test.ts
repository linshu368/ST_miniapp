import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  findUncoveredWordCounts,
  parseInteractionModeBlocks,
  parseTemplate,
  parseWordCountTiers,
} from './platform-instructions.js';
import { resolveWordCountPromptValue } from './render-instructions.js';

const MIGRATION_PATH = new URL(
  '../../../../shared/migrations/071_engine_platform_instructions.sql',
  import.meta.url
);

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf8');
}

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

  it('字数档位表的 snake_case 落库形态映射到接缝的 camelCase', () => {
    expect(
      parseWordCountTiers({
        tiers: [{ label: '300-500', prompt_value: '300-500' }],
        default_value: '300-500',
      })
    ).toEqual({ tiers: [{ label: '300-500', promptValue: '300-500' }], defaultValue: '300-500' });
  });

  it('档位表缺字段或为空时判为非法，交给调用方兜底', () => {
    expect(parseWordCountTiers({ tiers: [], default_value: '300-500' })).toBeNull();
    expect(
      parseWordCountTiers({ tiers: [{ label: '300-500' }], default_value: '300-500' })
    ).toBeNull();
    expect(
      parseWordCountTiers({ tiers: [{ label: '300-500', prompt_value: '300-500' }] })
    ).toBeNull();
  });
});

describe('findUncoveredWordCounts', () => {
  it('档位表覆盖全部 PreferredWordCount 时无告警', () => {
    expect(
      findUncoveredWordCounts({
        tiers: [
          { label: '100-300', promptValue: '100-300' },
          { label: '300-500', promptValue: '300-500' },
          { label: '500-800', promptValue: '500-800' },
          { label: '800+', promptValue: '800以上' },
        ],
        defaultValue: '300-500',
      })
    ).toEqual([]);
  });

  it('照抄 bot 档位文案时，四个枚举值全部未覆盖', () => {
    expect(
      findUncoveredWordCounts({
        tiers: [
          { label: '150以内', promptValue: '150以内' },
          { label: '150-300', promptValue: '150-300' },
          { label: '300-500', promptValue: '300-500' },
          { label: '500-700', promptValue: '500-700' },
          { label: '700-1000', promptValue: '700-1000' },
        ],
        defaultValue: '300-500',
      })
    ).toEqual(['100-300', '500-800', '800+']);
  });
});

describe('migration 071 落库正文', () => {
  it('模板含三个占位符', () => {
    const sql = readMigration();
    expect(sql).toContain('{{WORD_COUNT}}');
    expect(sql).toContain('{{INTERACTION_MODE}}');
    expect(sql).toContain('{{USER_CUSTOM_INSTRUCTIONS}}');
  });

  it('落库的档位表覆盖 PreferredWordCount 的每个取值，且每个取值都能命中', () => {
    const sql = readMigration();
    const match = /'pref_word_count_tiers',\s*('[^']*')::JSONB/.exec(sql);
    expect(match).not.toBeNull();

    const tiersConfig = parseWordCountTiers(JSON.parse((match?.[1] ?? '').slice(1, -1)) as unknown);
    expect(tiersConfig).not.toBeNull();
    if (!tiersConfig) return;

    expect(findUncoveredWordCounts(tiersConfig)).toEqual([]);
    expect(resolveWordCountPromptValue('100-300', tiersConfig)).toBe('100-300');
    expect(resolveWordCountPromptValue('800+', tiersConfig)).toBe('800以上');
    // default_value 必须是某个档位的 prompt_value，否则回落路径注入的是一个不存在的档位
    expect(tiersConfig.tiers.map((tier) => tier.promptValue)).toContain(tiersConfig.defaultValue);
  });
});
