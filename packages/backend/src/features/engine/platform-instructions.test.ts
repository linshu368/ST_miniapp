import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORD_COUNT_TIERS_CONFIG } from '@miniapp/shared';
import {
  buildSnapshot,
  parseInteractionModeBlocks,
  parseTemplate,
  parseWordCountTiers,
  toPublicWordCountTiersFromEngine,
} from './platform-instructions.js';
import { resolveWordCountPromptValue } from './render-instructions.js';
import type { RuntimeConfigEntry } from '../../platform/runtime-config.js';

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

describe('buildSnapshot：字数档位的契约校验与降级', () => {
  const TEMPLATE = '{{WORD_COUNT}} / {{INTERACTION_MODE}} / {{USER_CUSTOM_INSTRUCTIONS}}';

  function entries(wordCountValue: unknown): Map<string, RuntimeConfigEntry> {
    return new Map<string, RuntimeConfigEntry>([
      ['system_instructions', { value: null, textValue: TEMPLATE, version: 1 }],
      [
        'interaction_mode_blocks',
        { value: { options_on: '开', options_off: '关' }, textValue: null, version: 1 },
      ],
      ['pref_word_count_tiers', { value: wordCountValue, textValue: null, version: 7 }],
    ]);
  }

  const VALID = {
    tiers: [
      {
        id: '300-500',
        ui_label: '标准300-500',
        prompt_value: '300-500',
        enabled: true,
        sort_order: 0,
      },
      {
        id: '500-800',
        ui_label: '详细500-800',
        prompt_value: '500-800',
        enabled: true,
        sort_order: 1,
      },
    ],
    default_tier_id: '500-800',
    layout: { columns: 3 },
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('合法配置不降级，默认档与列布局按运营配置下发', () => {
    const snapshot = buildSnapshot(entries(VALID));
    expect(snapshot.degraded).toBe(false);

    const publicTiers = toPublicWordCountTiersFromEngine(snapshot.instructions.wordCountTiers);
    expect(publicTiers.default_tier_id).toBe('500-800');
    expect(publicTiers.tiers.map((tier) => tier.id)).toEqual(['300-500', '500-800']);
    expect(publicTiers.layout.columns).toBe(3);
  });

  // 回归：宽松解析放过、shared 契约拦下的配置，过去会静默把整张档位表换成内置默认档，
  // 既不打日志也不置 degraded，且 prompt 侧仍用运营配置——两个出口分叉。
  it.each([
    [
      'id 不合 id 正则',
      { ...VALID, tiers: [{ ...VALID.tiers[0], id: '标准档' }], default_tier_id: '标准档' },
    ],
    [
      'ui_label 超过 20 字',
      {
        ...VALID,
        tiers: [{ ...VALID.tiers[0], ui_label: '标'.repeat(21) }],
        default_tier_id: '300-500',
      },
    ],
    [
      'default_tier_id 指向停用档位',
      { ...VALID, tiers: VALID.tiers.map((tier) => ({ ...tier, enabled: tier.id !== '500-800' })) },
    ],
    [
      '档位 id 重复',
      {
        ...VALID,
        tiers: [VALID.tiers[0], { ...VALID.tiers[1], id: '300-500' }],
        default_tier_id: '300-500',
      },
    ],
  ])('%s：置 degraded、打日志，且两个出口都回落到内置兜底', (_name, wordCountValue) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const snapshot = buildSnapshot(entries(wordCountValue));

    expect(snapshot.degraded).toBe(true);
    expect(logged).toHaveBeenCalledOnce();
    const message = String(logged.mock.calls[0]?.[0]);
    expect(message).toContain('pref_word_count_tiers');
    expect(message).toContain('version 7');

    // prompt 出口与 MiniApp 出口必须是同一份内置兜底
    const publicTiers = toPublicWordCountTiersFromEngine(snapshot.instructions.wordCountTiers);
    expect(publicTiers.default_tier_id).toBe(DEFAULT_WORD_COUNT_TIERS_CONFIG.default_tier_id);
    expect(snapshot.instructions.wordCountTiers.defaultTierId).toBe(
      DEFAULT_WORD_COUNT_TIERS_CONFIG.default_tier_id
    );
    expect(publicTiers.tiers.map((tier) => tier.id)).toEqual(
      DEFAULT_WORD_COUNT_TIERS_CONFIG.tiers.map((tier) => tier.id)
    );
  });

  it('契约校验后的值回灌引擎侧，prompt 与 MiniApp 拿到同一份 trim 结果', () => {
    const snapshot = buildSnapshot(
      entries({
        ...VALID,
        tiers: [{ ...VALID.tiers[0], id: '  300-500  ' }],
        default_tier_id: '  300-500  ',
      })
    );

    expect(snapshot.degraded).toBe(false);
    expect(snapshot.instructions.wordCountTiers.tiers.map((tier) => tier.id)).toEqual(['300-500']);
    // 用户存档的是 trim 后的 id，prompt 侧必须能命中，不能因为配置里带空格而回落
    expect(resolveWordCountPromptValue('300-500', snapshot.instructions.wordCountTiers)).toBe(
      '300-500'
    );
    expect(toPublicWordCountTiersFromEngine(snapshot.instructions.wordCountTiers).tiers).toEqual([
      { id: '300-500', ui_label: '标准300-500', sort_order: 0 },
    ]);
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
