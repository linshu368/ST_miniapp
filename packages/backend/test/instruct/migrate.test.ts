/**
 * Step 1 — migrateInstructSettings 单测
 *
 * Q3 选项 B：不进 baseline-runner 字节级真值，靠手工构造的 legacy
 * preset blob + vitest 断言来锁定 migration 规则。原因详见
 * 「Step 1 实践计划」Q3 章节——这函数是确定性 schema 重命名工具，
 * 不参与 prompt 字符串装配，byte-exact baseline 价值不大。
 *
 * 覆盖 ST `instruct-mode.js:55-105 migrateInstructModeSettings` 的
 * 四个联动点：
 *
 *   A. 重命名：separator_sequence → output_suffix
 *   B. 三态合并：names + names_force_groups → names_behavior
 *   C. 默认补齐：13 个 evergreen 字段
 *   D. 废弃字段删除：names / names_force_groups /
 *      system_sequence_prefix / system_sequence_suffix
 *
 * 还有一个 E 段做综合验证（古早 ST 1.10 风格 preset 一次性迁完）。
 */

import { describe, test, expect } from 'vitest';

import { migrateInstructSettings } from '../../src/prompt-engine/instruct.js';

// ─── 默认补齐字段清单（与 instruct-mode.js:71 保持一致） ────────────────────

const DEFAULT_FIELDS = {
  input_suffix: '',
  system_sequence: '',
  system_suffix: '',
  user_alignment_message: '',
  last_system_sequence: '',
  first_input_sequence: '',
  last_input_sequence: '',
  skip_examples: false,
  system_same_as_user: false,
  // 注意：names_behavior 的 backfill 默认是 'force'（migration bias，
  // 与 host.js 的 createDefaultInstruct 'none' 默认有意区分——后者
  // 是「全新对象的中性默认」，前者是「legacy preset 没填时的兼容默认」）
  names_behavior: 'force',
  sequences_as_stop_strings: true,
  story_string_prefix: '',
  story_string_suffix: '',
} as const;

const OBSOLETE_FIELDS = [
  'names',
  'names_force_groups',
  'system_sequence_prefix',
  'system_sequence_suffix',
] as const;

// ─── A. 重命名：separator_sequence → output_suffix ──────────────────────────

describe('A. 重命名 separator_sequence → output_suffix', () => {
  test('A1: 非空 separator_sequence 应改名为 output_suffix', () => {
    const settings: Record<string, unknown> = { separator_sequence: '<|im_end|>' };
    migrateInstructSettings(settings);
    expect(settings.output_suffix).toBe('<|im_end|>');
    expect('separator_sequence' in settings).toBe(false);
  });

  test('A2: 空 separator_sequence 也应迁移（空字符串），并删除原字段', () => {
    // ST 原版用 `settings.output_suffix = settings.separator_sequence || ''`，
    // 所以 falsy 会落到 ''。delete 行为与 truthy/falsy 无关，永远删。
    const settings: Record<string, unknown> = { separator_sequence: '' };
    migrateInstructSettings(settings);
    expect(settings.output_suffix).toBe('');
    expect('separator_sequence' in settings).toBe(false);
  });

  test('A3: 不存在 separator_sequence 时不触发迁移，但 output_suffix 仍走默认补齐', () => {
    const settings: Record<string, unknown> = {};
    migrateInstructSettings(settings);
    // 默认补齐里没列 output_suffix，所以它不在 DEFAULT_FIELDS 列表里——
    // 这条用例其实在验「不补齐 output_suffix」这件事
    expect('output_suffix' in settings).toBe(false);
  });
});

// ─── B. 三态合并：names + names_force_groups → names_behavior ───────────────

describe('B. names + names_force_groups → names_behavior 三态合并', () => {
  test('B1: names=true → names_behavior=ALWAYS（无视 names_force_groups）', () => {
    const settings: Record<string, unknown> = { names: true, names_force_groups: false };
    migrateInstructSettings(settings);
    expect(settings.names_behavior).toBe('always');
  });

  test('B2: names=true + names_force_groups=true → 仍 ALWAYS（names 主导）', () => {
    const settings: Record<string, unknown> = { names: true, names_force_groups: true };
    migrateInstructSettings(settings);
    expect(settings.names_behavior).toBe('always');
  });

  test('B3: names=false + names_force_groups=true → FORCE', () => {
    const settings: Record<string, unknown> = { names: false, names_force_groups: true };
    migrateInstructSettings(settings);
    expect(settings.names_behavior).toBe('force');
  });

  test('B4: names=false + names_force_groups=false → NONE', () => {
    const settings: Record<string, unknown> = { names: false, names_force_groups: false };
    migrateInstructSettings(settings);
    expect(settings.names_behavior).toBe('none');
  });

  test('B5: names 字段不存在 → 不触发迁移块；names_behavior 走默认补齐 force', () => {
    const settings: Record<string, unknown> = { names_force_groups: true };
    migrateInstructSettings(settings);
    // 没进 if (settings.names !== undefined) 分支，所以 names_behavior 走 defaults
    expect(settings.names_behavior).toBe('force');
    // names_force_groups 走 obsoleteFields 兜底删除
    expect('names_force_groups' in settings).toBe(false);
  });

  test('B6: names=undefined 显式传入也应跳过迁移块', () => {
    // ST 用 `settings.names !== undefined` 判定，所以 undefined 显式赋值会被识别为 absent
    const settings: Record<string, unknown> = { names: undefined };
    migrateInstructSettings(settings);
    expect(settings.names_behavior).toBe('force'); // 走默认补齐
  });
});

// ─── C. 默认补齐 13 个字段 ──────────────────────────────────────────────────

describe('C. 默认补齐', () => {
  test('C1: 空对象输入 → 全部 13 个字段按默认补齐', () => {
    const settings: Record<string, unknown> = {};
    migrateInstructSettings(settings);
    for (const [key, expected] of Object.entries(DEFAULT_FIELDS)) {
      expect(settings[key]).toBe(expected);
    }
  });

  test('C2: 已有字段不被覆盖（非 undefined 的值保留）', () => {
    const settings: Record<string, unknown> = {
      input_suffix: 'custom-suffix',
      skip_examples: true,
      sequences_as_stop_strings: false, // 默认 true，这里要求保持 false
      names_behavior: 'always', // 默认 force，这里要求保持 always
    };
    migrateInstructSettings(settings);
    expect(settings.input_suffix).toBe('custom-suffix');
    expect(settings.skip_examples).toBe(true);
    expect(settings.sequences_as_stop_strings).toBe(false);
    expect(settings.names_behavior).toBe('always');
  });

  test('C3: 字段值为 null 不算 undefined，不被覆盖（与 ST 原版 `=== undefined` 判定一致）', () => {
    const settings: Record<string, unknown> = { system_sequence: null };
    migrateInstructSettings(settings);
    expect(settings.system_sequence).toBeNull();
  });
});

// ─── D. 废弃字段删除 ───────────────────────────────────────────────────────

describe('D. 废弃字段删除', () => {
  test('D1: 全部四个废字段都该被删除（即使迁移块没动它们）', () => {
    const settings: Record<string, unknown> = {
      names: false,
      names_force_groups: false,
      system_sequence_prefix: '### ',
      system_sequence_suffix: '\n###',
    };
    migrateInstructSettings(settings);
    for (const f of OBSOLETE_FIELDS) {
      expect(f in settings).toBe(false);
    }
  });

  test('D2: 仅 system_sequence_prefix/suffix 存在（非 names 系列） → 它们独立被删', () => {
    const settings: Record<string, unknown> = {
      system_sequence_prefix: '<<SYS>>',
      system_sequence_suffix: '<</SYS>>',
    };
    migrateInstructSettings(settings);
    expect('system_sequence_prefix' in settings).toBe(false);
    expect('system_sequence_suffix' in settings).toBe(false);
  });

  test('D3: 字段不存在时删除是 no-op，不抛异常', () => {
    const settings: Record<string, unknown> = {};
    expect(() => migrateInstructSettings(settings)).not.toThrow();
    for (const f of OBSOLETE_FIELDS) {
      expect(f in settings).toBe(false);
    }
  });
});

// ─── E. 综合：古早 legacy preset 一次性迁完 ─────────────────────────────────

describe('E. 综合 legacy preset 迁移', () => {
  test('E1: ST 1.10 风格 preset 应一次性变成 evergreen 格式', () => {
    // 模拟一份古早 instruct preset：
    //   - 用 separator_sequence 而非 output_suffix
    //   - 用 names + names_force_groups 二元 boolean
    //   - 含 system_sequence_prefix / system_sequence_suffix 废字段
    //   - 缺失大量 1.12 才加的字段（system_sequence/skip_examples/...）
    const legacy: Record<string, unknown> = {
      name: 'Llama2 (legacy)',
      enabled: true,
      wrap: true,
      macro: false,
      separator_sequence: '</s>',
      input_sequence: '[INST] ',
      output_sequence: ' [/INST]',
      stop_sequence: '</s>',
      names: true,
      names_force_groups: true,
      system_sequence_prefix: '<<SYS>>\n',
      system_sequence_suffix: '\n<</SYS>>\n\n',
      activation_regex: '/llama-?2/i',
    };

    migrateInstructSettings(legacy);

    // —— 重命名生效 ——
    expect(legacy.output_suffix).toBe('</s>');
    expect('separator_sequence' in legacy).toBe(false);

    // —— 枚举合并生效 ——
    expect(legacy.names_behavior).toBe('always');

    // —— 废字段删除 ——
    for (const f of OBSOLETE_FIELDS) {
      expect(f in legacy).toBe(false);
    }

    // —— 默认补齐生效（缺失的字段都被填上） ——
    expect(legacy.input_suffix).toBe('');
    expect(legacy.system_sequence).toBe('');
    expect(legacy.system_suffix).toBe('');
    expect(legacy.user_alignment_message).toBe('');
    expect(legacy.last_system_sequence).toBe('');
    expect(legacy.first_input_sequence).toBe('');
    expect(legacy.last_input_sequence).toBe('');
    expect(legacy.skip_examples).toBe(false);
    expect(legacy.system_same_as_user).toBe(false);
    expect(legacy.sequences_as_stop_strings).toBe(true);
    expect(legacy.story_string_prefix).toBe('');
    expect(legacy.story_string_suffix).toBe('');

    // —— 已有的字段保留原值 ——
    expect(legacy.name).toBe('Llama2 (legacy)');
    expect(legacy.enabled).toBe(true);
    expect(legacy.wrap).toBe(true);
    expect(legacy.input_sequence).toBe('[INST] ');
    expect(legacy.output_sequence).toBe(' [/INST]');
    expect(legacy.stop_sequence).toBe('</s>');
    expect(legacy.activation_regex).toBe('/llama-?2/i');
  });

  test('E2: 已经是 evergreen 的 preset 再迁一次 → 应是幂等的', () => {
    // 跑一次 → 拿到 evergreen 版；再跑一次 → 内容应不变
    const fresh: Record<string, unknown> = {
      separator_sequence: '<|end|>',
      names: false,
      names_force_groups: true,
    };
    migrateInstructSettings(fresh);
    const afterOnce = JSON.parse(JSON.stringify(fresh));
    migrateInstructSettings(fresh);
    expect(fresh).toEqual(afterOnce);
  });
});

// ─── F. 返回值约定 ─────────────────────────────────────────────────────────

describe('F. 返回值约定', () => {
  test('F1: 返回值就是传入对象（同一引用），不是 clone', () => {
    const settings: Record<string, unknown> = { input_sequence: 'X' };
    const ret = migrateInstructSettings(settings);
    expect(ret).toBe(settings);
  });
});
