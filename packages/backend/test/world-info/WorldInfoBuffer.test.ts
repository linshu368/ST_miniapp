/**
 * Step 2.1 — WorldInfoBuffer 单元测试
 *
 * Done criteria（来自「具体执行步骤.pdf」Step 2.1 节）：
 *   1. get() 在 scanState=MIN_ACTIVATIONS 时，#recurseBuffer 的内容
 *      不出现在返回值中
 *   2. advanceScan() 后 getDepth() 返回值 +1
 *
 * 这两个测试不依赖任何 ST 运行时环境，纯单元测试。
 */

import { describe, test, expect } from 'vitest';
import { WorldInfoBuffer } from '../../src/prompt-engine/world-info/WorldInfoBuffer.js';
import { scan_state } from '../../src/prompt-engine/world-info/constants.js';
import type {
  WIEntry,
  WIGlobalScanData,
  WISettings,
} from '../../src/prompt-engine/world-info/types.js';

// ─── 测试辅助：构造最小 WISettings ────────────────────────────────────────────

function makeSettings(overrides: Partial<WISettings> = {}): Required<WISettings> {
  return {
    world_info_depth: 2,
    world_info_min_activations: 0,
    world_info_min_activations_depth_max: 0,
    world_info_budget: 25,
    world_info_budget_cap: 0,
    world_info_include_names: true,
    world_info_recursive: false,
    world_info_overflow_alert: false,
    world_info_case_sensitive: false,
    world_info_match_whole_words: false,
    world_info_use_group_scoring: false,
    world_info_character_strategy: 1,
    world_info_max_recursion_steps: 0,
    ...overrides,
  };
}

/** 构造一条最小可用的 WIEntry（只填必要字段） */
function makeEntry(overrides: Partial<WIEntry> = {}): WIEntry {
  return {
    world: 'test',
    uid: 0,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    selective: false,
    content: '',
    comment: '',
    disable: false,
    constant: false,
    vectorized: false,
    probability: 100,
    useProbability: false,
    order: 100,
    ignoreBudget: false,
    position: 0,
    depth: 4,
    outletName: '',
    role: 0,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    sticky: null,
    cooldown: null,
    delay: null,
    characterFilterNames: [],
    characterFilterTags: [],
    characterFilterExclude: false,
    triggers: [],
    automationId: '',
    addMemo: false,
    ...overrides,
  };
}

const EMPTY_GLOBAL_SCAN_DATA: WIGlobalScanData = {
  trigger: 'normal',
  personaDescription: '',
  characterDescription: '',
  characterPersonality: '',
  characterDepthPrompt: '',
  scenario: '',
  creatorNotes: '',
};

// ─── Done criteria 1：MIN_ACTIVATIONS 时 recurseBuffer 不出现在返回值 ──────────

describe('Done criteria 1 — get() 在 MIN_ACTIVATIONS 状态下隔离 recurseBuffer', () => {
  test('1a: scanState=INITIAL 时，recurseBuffer 内容出现在返回值中（基准对照）', () => {
    // depth=2，消息列表有 2 条
    const messages = ['msg-depth-0', 'msg-depth-1'];
    const settings = makeSettings({ world_info_depth: 2 });
    const buf = new WorldInfoBuffer(messages, EMPTY_GLOBAL_SCAN_DATA, settings);

    const RECURSE_TEXT = 'recursed-content';
    buf.addRecurse(RECURSE_TEXT);

    const entry = makeEntry({ scanDepth: null }); // 使用全局 depth=2
    const result = buf.get(entry, scan_state.INITIAL);

    // INITIAL 状态：recurseBuffer 应拼入
    expect(result).toContain(RECURSE_TEXT);
  });

  test('1b: scanState=RECURSION 时，recurseBuffer 内容也出现（非 MIN_ACTIVATIONS）', () => {
    const messages = ['msg-depth-0', 'msg-depth-1'];
    const settings = makeSettings({ world_info_depth: 2 });
    const buf = new WorldInfoBuffer(messages, EMPTY_GLOBAL_SCAN_DATA, settings);

    const RECURSE_TEXT = 'recursed-content';
    buf.addRecurse(RECURSE_TEXT);

    const entry = makeEntry({ scanDepth: null });
    const result = buf.get(entry, scan_state.RECURSION);

    expect(result).toContain(RECURSE_TEXT);
  });

  test('1c: [RISK-2] scanState=MIN_ACTIVATIONS 时，recurseBuffer 内容不出现在返回值中', () => {
    // 这是最关键的边界：MIN_ACTIVATIONS 轮次不能扫描 recurseBuffer
    const messages = ['msg-depth-0', 'msg-depth-1'];
    const settings = makeSettings({ world_info_depth: 2 });
    const buf = new WorldInfoBuffer(messages, EMPTY_GLOBAL_SCAN_DATA, settings);

    const RECURSE_TEXT = 'recursed-content-should-be-hidden';
    buf.addRecurse(RECURSE_TEXT);

    const entry = makeEntry({ scanDepth: null });
    const result = buf.get(entry, scan_state.MIN_ACTIVATIONS);

    // [RISK-2] 核心断言：MIN_ACTIVATIONS 时 recurseBuffer 必须被屏蔽
    expect(result).not.toContain(RECURSE_TEXT);
  });

  test('1d: [RISK-2] injectBuffer 在 MIN_ACTIVATIONS 时仍应出现（始终拼入）', () => {
    // injectBuffer 与 scanState 无关，始终拼入——与 recurseBuffer 的屏蔽规则形成对比
    const messages = ['msg-depth-0', 'msg-depth-1'];
    const settings = makeSettings({ world_info_depth: 2 });
    const buf = new WorldInfoBuffer(messages, EMPTY_GLOBAL_SCAN_DATA, settings);

    const INJECT_TEXT = 'injected-content-always-visible';
    buf.addInject(INJECT_TEXT);

    const entry = makeEntry({ scanDepth: null });
    const result = buf.get(entry, scan_state.MIN_ACTIVATIONS);

    // [RISK-2] 条件 3：injectBuffer 不受 scanState 影响
    expect(result).toContain(INJECT_TEXT);
  });
});

// ─── Done criteria 2：advanceScan() 后 getDepth() +1 ─────────────────────────

describe('Done criteria 2 — advanceScan() 使 getDepth() 递增', () => {
  test('2a: 初始 getDepth() 等于 settings.world_info_depth', () => {
    const DEPTH = 5;
    const settings = makeSettings({ world_info_depth: DEPTH });
    const buf = new WorldInfoBuffer([], EMPTY_GLOBAL_SCAN_DATA, settings);

    expect(buf.getDepth()).toBe(DEPTH);
  });

  test('2b: 调用一次 advanceScan() 后 getDepth() = world_info_depth + 1', () => {
    const DEPTH = 3;
    const settings = makeSettings({ world_info_depth: DEPTH });
    const buf = new WorldInfoBuffer([], EMPTY_GLOBAL_SCAN_DATA, settings);

    buf.advanceScan();

    expect(buf.getDepth()).toBe(DEPTH + 1);
  });

  test('2c: 多次 advanceScan() 累加，每次 +1', () => {
    const DEPTH = 2;
    const settings = makeSettings({ world_info_depth: DEPTH });
    const buf = new WorldInfoBuffer([], EMPTY_GLOBAL_SCAN_DATA, settings);

    buf.advanceScan();
    buf.advanceScan();
    buf.advanceScan();

    expect(buf.getDepth()).toBe(DEPTH + 3);
  });
});

// ─── 附加：hasRecurse() 基本行为 ─────────────────────────────────────────────

describe('hasRecurse() 基本行为', () => {
  test('初始为 false', () => {
    const buf = new WorldInfoBuffer([], EMPTY_GLOBAL_SCAN_DATA, makeSettings());
    expect(buf.hasRecurse()).toBe(false);
  });

  test('addRecurse() 后变为 true', () => {
    const buf = new WorldInfoBuffer([], EMPTY_GLOBAL_SCAN_DATA, makeSettings());
    buf.addRecurse('some text');
    expect(buf.hasRecurse()).toBe(true);
  });
});

// ─── 附加：get() depth <= startDepth 返回空串 ────────────────────────────────

describe('get() depth 边界', () => {
  test('depth=0（entry.scanDepth=0）返回空串', () => {
    const messages = ['msg0', 'msg1'];
    const buf = new WorldInfoBuffer(messages, EMPTY_GLOBAL_SCAN_DATA, makeSettings());
    const entry = makeEntry({ scanDepth: 0 }); // depth=0 <= startDepth=0
    expect(buf.get(entry, scan_state.INITIAL)).toBe('');
  });

  test('depth=1 时返回非空（depth > startDepth=0）', () => {
    const messages = ['msg0', 'msg1'];
    const buf = new WorldInfoBuffer(messages, EMPTY_GLOBAL_SCAN_DATA, makeSettings());
    const entry = makeEntry({ scanDepth: 1 });
    expect(buf.get(entry, scan_state.INITIAL)).toContain('msg0');
  });
});
