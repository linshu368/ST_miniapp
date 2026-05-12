/**
 * Step 2.2 — WorldInfoTimedEffects 单元测试
 *
 * Done criteria（来自「具体执行步骤.pdf」Step 2.2 节）：
 *   对空 effects 状态，以下三个调用均返回 false：
 *     - isEffectActive('sticky', entry)
 *     - isEffectActive('cooldown', entry)
 *     - isEffectActive('delay', entry)
 *
 * 附加测试（覆盖核心行为）：
 *   - isDryRun=true 时 setTimedEffects() 不写入持久化状态
 *   - isDryRun=false 时 setTimedEffects() 写入持久化状态并触发回调
 *   - checkTimedEffects() 在 isDryRun=true 时仍然执行 delay 效果
 *   - checkTimedEffects() 在 isDryRun=true 时跳过 sticky/cooldown 读写
 *   - cleanUp() 清空 buffer 后 isEffectActive 重新返回 false
 *   - isValidEffectType() 边界
 *   - sticky 到期时自动触发 cooldown（onEnded.sticky 回调）
 */

import { describe, test, expect, vi } from 'vitest';
import { WorldInfoTimedEffects } from '../../src/prompt-engine/world-info/WorldInfoTimedEffects.js';
import type { WIEntry, WITimedEffect } from '../../src/prompt-engine/world-info/types.js';

// ─── 测试辅助 ─────────────────────────────────────────────────────────────────

/** 构造一条最小可用的 WIEntry（只填必要字段） */
function makeEntry(overrides: Partial<WIEntry> = {}): WIEntry {
  return {
    world: 'test-world',
    uid: 1,
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
    hash: 12345,
    ...overrides,
  };
}

// ─── Done criteria：空 effects 状态下 isEffectActive 均返回 false ─────────────

describe('Done criteria — isEffectActive 对空 effects 状态返回 false', () => {
  // 空聊天、空条目、isDryRun=true（最简场景）
  const te = new WorldInfoTimedEffects([], [], true);

  const entry = makeEntry();

  test('isEffectActive("sticky", entry) → false（空 effects）', () => {
    expect(te.isEffectActive('sticky', entry)).toBe(false);
  });

  test('isEffectActive("cooldown", entry) → false（空 effects）', () => {
    expect(te.isEffectActive('cooldown', entry)).toBe(false);
  });

  test('isEffectActive("delay", entry) → false（空 effects）', () => {
    expect(te.isEffectActive('delay', entry)).toBe(false);
  });
});

// ─── isValidEffectType 边界 ───────────────────────────────────────────────────

describe('isValidEffectType()', () => {
  const te = new WorldInfoTimedEffects([], [], true);

  test('"sticky" 是合法类型', () => expect(te.isValidEffectType('sticky')).toBe(true));
  test('"cooldown" 是合法类型', () => expect(te.isValidEffectType('cooldown')).toBe(true));
  test('"delay" 是合法类型', () => expect(te.isValidEffectType('delay')).toBe(true));
  test('"STICKY"（大写）也合法（trim+toLowerCase）', () =>
    expect(te.isValidEffectType('STICKY')).toBe(true));
  test('"unknown" 不合法', () => expect(te.isValidEffectType('unknown')).toBe(false));
  test('空字符串不合法', () => expect(te.isValidEffectType('')).toBe(false));
});

// ─── isDryRun=true 时 setTimedEffects 不写持久化 ─────────────────────────────

describe('isDryRun=true — setTimedEffects 跳过持久化', () => {
  test('调用 setTimedEffects 后不触发 onTimedEffectsUpdate 回调', () => {
    const onUpdate = vi.fn();
    const entry = makeEntry({ sticky: 3, hash: 100 });
    const te = new WorldInfoTimedEffects(
      ['msg0', 'msg1'],
      [entry],
      true, // isDryRun
      { onTimedEffectsUpdate: onUpdate }
    );

    te.setTimedEffects([entry]);

    expect(onUpdate).not.toHaveBeenCalled();
  });

  test('调用 setTimedEffects 后 getEffectMetadata 仍返回 null', () => {
    const entry = makeEntry({ sticky: 3, hash: 100 });
    const te = new WorldInfoTimedEffects(['msg0'], [entry], true);

    te.setTimedEffects([entry]);

    expect(te.getEffectMetadata('sticky', entry)).toBeNull();
  });
});

// ─── isDryRun=false 时 setTimedEffects 写入持久化 ─────────────────────────────

describe('isDryRun=false — setTimedEffects 写入持久化', () => {
  test('调用 setTimedEffects 后触发 onTimedEffectsUpdate 回调', () => {
    const onUpdate = vi.fn();
    const entry = makeEntry({ sticky: 3, hash: 200 });
    const te = new WorldInfoTimedEffects(
      ['msg0', 'msg1'],
      [entry],
      false, // isDryRun=false → 真实写入
      { onTimedEffectsUpdate: onUpdate }
    );

    te.setTimedEffects([entry]);

    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  test('调用 setTimedEffects 后 getEffectMetadata 返回正确记录', () => {
    const entry = makeEntry({ sticky: 5, hash: 201 });
    const chat = ['m0', 'm1', 'm2']; // length = 3
    const te = new WorldInfoTimedEffects(chat, [entry], false);

    te.setTimedEffects([entry]);

    const meta = te.getEffectMetadata('sticky', entry) as WITimedEffect;
    expect(meta).not.toBeNull();
    expect(meta.hash).toBe(201);
    expect(meta.start).toBe(3); // chat.length
    expect(meta.end).toBe(3 + 5); // chat.length + sticky
    expect(meta.protected).toBe(false);
  });

  test('同一条目不会被写入两次（幂等保护）', () => {
    const onUpdate = vi.fn();
    const entry = makeEntry({ sticky: 2, hash: 202 });
    const te = new WorldInfoTimedEffects(['msg'], [entry], false, {
      onTimedEffectsUpdate: onUpdate,
    });

    te.setTimedEffects([entry]);
    te.setTimedEffects([entry]); // 第二次应跳过

    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});

// ─── checkTimedEffects + delay 效果 ──────────────────────────────────────────

describe('checkTimedEffects() — delay 效果（不受 isDryRun 影响）', () => {
  test('聊天长度 < entry.delay 时，isEffectActive("delay") 返回 true', () => {
    const entry = makeEntry({ delay: 5, hash: 300 }); // 需要聊天 >= 5 条才解锁
    const chat = ['m0', 'm1']; // length=2 < 5 → 仍被 delay 压制

    const te = new WorldInfoTimedEffects(chat, [entry], true); // isDryRun=true
    te.checkTimedEffects();

    expect(te.isEffectActive('delay', entry)).toBe(true);
  });

  test('聊天长度 >= entry.delay 时，isEffectActive("delay") 返回 false', () => {
    const entry = makeEntry({ delay: 2, hash: 301 });
    const chat = ['m0', 'm1', 'm2']; // length=3 >= 2 → delay 不再压制

    const te = new WorldInfoTimedEffects(chat, [entry], true);
    te.checkTimedEffects();

    expect(te.isEffectActive('delay', entry)).toBe(false);
  });

  test('entry.delay 为 null 时不进入 delay buffer', () => {
    const entry = makeEntry({ delay: null, hash: 302 });
    const chat = ['m0']; // 只有 1 条

    const te = new WorldInfoTimedEffects(chat, [entry], true);
    te.checkTimedEffects();

    expect(te.isEffectActive('delay', entry)).toBe(false);
  });
});

// ─── checkTimedEffects + sticky/cooldown（isDryRun=true 时跳过）─────────────

describe('checkTimedEffects() — isDryRun=true 时跳过 sticky/cooldown 处理', () => {
  test('传入含 sticky 的持久化状态，isDryRun=true 时 isEffectActive("sticky") 仍为 false', () => {
    const entry = makeEntry({ sticky: 3, hash: 400 });
    const chat = ['m0', 'm1', 'm2']; // length=3

    // 模拟已有持久化 sticky 记录（start=0, end=3, 但 chat.length 已到 3 → 到期）
    const timedWorldInfo = {
      sticky: {
        'test-world.1': { hash: 400, start: 0, end: 10, protected: false } as WITimedEffect,
      },
      cooldown: {},
    };

    const te = new WorldInfoTimedEffects(chat, [entry], true, { timedWorldInfo }); // isDryRun=true
    te.checkTimedEffects(); // sticky/cooldown 处理被跳过

    // isDryRun=true → #checkTimedEffectOfType 未调用 → buffer.sticky 仍为空
    expect(te.isEffectActive('sticky', entry)).toBe(false);
  });
});

// ─── checkTimedEffects + sticky/cooldown（isDryRun=false）────────────────────

describe('checkTimedEffects() — isDryRun=false 时处理 sticky/cooldown', () => {
  test('有效的 sticky 记录使 isEffectActive("sticky") 返回 true', () => {
    const entry = makeEntry({ sticky: 5, hash: 500 });
    const chat = ['m0', 'm1', 'm2']; // length=3

    // sticky 记录：start=1（已推进），end=6（未到期），protected=false
    const timedWorldInfo = {
      sticky: {
        'test-world.1': { hash: 500, start: 1, end: 6, protected: false } as WITimedEffect,
      },
      cooldown: {},
    };

    const te = new WorldInfoTimedEffects(chat, [entry], false, { timedWorldInfo });
    te.checkTimedEffects();

    expect(te.isEffectActive('sticky', entry)).toBe(true);
  });

  test('已到期的 sticky 记录不进入 buffer（isEffectActive 返回 false）', () => {
    const entry = makeEntry({ sticky: 2, hash: 501 });
    const chat = ['m0', 'm1', 'm2', 'm3']; // length=4

    // sticky 记录：start=0，end=2（已到期：chat.length=4 >= end=2）
    const timedWorldInfo = {
      sticky: {
        'test-world.1': { hash: 501, start: 0, end: 2, protected: false } as WITimedEffect,
      },
      cooldown: {},
    };

    const te = new WorldInfoTimedEffects(chat, [entry], false, { timedWorldInfo });
    te.checkTimedEffects();

    expect(te.isEffectActive('sticky', entry)).toBe(false);
  });
});

// ─── cleanUp() ───────────────────────────────────────────────────────────────

describe('cleanUp() — 清空 buffer', () => {
  test('checkTimedEffects() 后 isEffectActive 为 true，cleanUp() 后变回 false', () => {
    const entry = makeEntry({ delay: 10, hash: 600 });
    const chat: string[] = []; // length=0 < 10 → delay 激活

    const te = new WorldInfoTimedEffects(chat, [entry], true);
    te.checkTimedEffects();

    expect(te.isEffectActive('delay', entry)).toBe(true); // 激活前确认

    te.cleanUp();

    expect(te.isEffectActive('delay', entry)).toBe(false); // 清空后
  });
});

// ─── sticky 到期自动触发 cooldown（onEnded.sticky 回调）─────────────────────

describe('sticky 到期 → 自动添加 cooldown（若 entry.cooldown 有值）', () => {
  test('sticky 到期且 entry.cooldown=3 时，cooldown buffer 被填入', () => {
    const entry = makeEntry({ sticky: 2, cooldown: 3, hash: 700 });
    const chat = ['m0', 'm1', 'm2', 'm3']; // length=4，sticky end=2，已到期

    const timedWorldInfo = {
      sticky: {
        'test-world.1': { hash: 700, start: 0, end: 2, protected: false } as WITimedEffect,
      },
      cooldown: {},
    };

    const onUpdate = vi.fn();
    const te = new WorldInfoTimedEffects(chat, [entry], false, {
      timedWorldInfo,
      onTimedEffectsUpdate: onUpdate,
    });
    te.checkTimedEffects();

    // sticky 到期 → onEnded.sticky 被调用 → cooldown 立即写入并推入 buffer
    expect(te.isEffectActive('cooldown', entry)).toBe(true);
    // 并且持久化更新回调被触发（至少写入了 cooldown 记录）
    expect(onUpdate).toHaveBeenCalled();
  });
});
