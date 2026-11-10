import {
  DEFAULT_STORY_MEMORY_CONFIG,
  DEFAULT_STORY_MEMORY_PROMPT,
  extractStoryMemorySections,
  StoryMemoryConfigSchema,
  StoryMemoryPromptSchema,
} from '@miniapp/shared';
import { describe, expect, it, vi } from 'vitest';
import { chunkTurns } from './compress-job.js';
import {
  countChars,
  renderPromptTemplate,
  renderStoryMemoryBlock,
  renderTurnsForCompression,
  stripTurnLabels,
  turnBodyChars,
} from './text.js';
import { validateStoryMemory } from './validate.js';
import { awaitStoryMemory, STORY_MEMORY_MAX_EXTRA_WAIT_MS } from './turn.js';
import { decideContextWindow, hardCapChars, planContextWindow } from './window-plan.js';

const limits = {
  high_watermark_chars: 1000,
  low_watermark_chars: 600,
  min_keep_turns: 11,
  min_removable_turns: 3,
};

function turns(count: number, chars: number, from = 1) {
  return Array.from({ length: count }, (_, index) => ({ turnIndex: from + index, chars }));
}

describe('planContextWindow', () => {
  it('does not move while the window stays under the high watermark', () => {
    const plan = planContextWindow({
      turns: turns(20, 40),
      currentInputChars: 10,
      currentStart: 1,
      limits,
    });
    expect(plan).toMatchObject({ startTurn: 1, advanced: false, floorBinding: false });
  });

  it('drops whole turns from the front until it is at or below the low watermark', () => {
    // 30 turns × 40 = 1200 + 20 input = 1220 > 1000; must reach ≤ 600 → drop 16 turns.
    const plan = planContextWindow({
      turns: turns(30, 40, 5),
      currentInputChars: 20,
      currentStart: 5,
      limits,
    });
    expect(plan.advanced).toBe(true);
    expect(plan.removedTurns).toBe(16);
    expect(plan.startTurn).toBe(21);
    expect(plan.totalChars - plan.removedChars).toBeLessThanOrEqual(600);
    expect(plan.floorBinding).toBe(false);
  });

  it('never removes the most recent min_keep_turns turns and reports floor binding', () => {
    // 14 huge turns: only 3 removable, and they cannot bring the total under L.
    const plan = planContextWindow({
      turns: turns(14, 200),
      currentInputChars: 0,
      currentStart: 1,
      limits,
    });
    expect(plan.removedTurns).toBe(3);
    expect(plan.startTurn).toBe(4);
    expect(plan.floorBinding).toBe(true);
  });

  it('does not truncate when fewer than min_removable_turns turns are removable', () => {
    const plan = planContextWindow({
      turns: turns(13, 200),
      currentInputChars: 0,
      currentStart: 1,
      limits,
    });
    expect(plan).toMatchObject({ startTurn: 1, advanced: false, floorBinding: true });
  });
});

describe('decideContextWindow (compress first, then truncate)', () => {
  // 29 × 40 + 20 = 1180: over U (1000), under the hard cap (1200) → desired start 20, target 19.
  const plan = planContextWindow({
    turns: turns(29, 40, 5),
    currentInputChars: 20,
    currentStart: 5,
    limits,
  });
  const base = { plan, currentStart: 5, memoryEnabled: true, limits };

  it('waits without moving the window until memory covers the removed turns', () => {
    expect(decideContextWindow({ ...base, coverage: 4 })).toEqual({
      action: 'wait',
      startTurn: 5,
      targetEnd: 19,
    });
  });

  it('advances window and memory together once coverage lands, as far as it covers', () => {
    expect(decideContextWindow({ ...base, coverage: 19 })).toMatchObject({
      action: 'advance',
      startTurn: 20,
    });
    expect(decideContextWindow({ ...base, coverage: 30 })).toMatchObject({ startTurn: 20 });
    expect(decideContextWindow({ ...base, coverage: 12 })).toMatchObject({
      action: 'advance',
      startTurn: 13,
      targetEnd: 19,
    });
  });

  it('forces truncation past the hard cap, and truncates directly when memory is off', () => {
    expect(hardCapChars(limits)).toBe(1200);
    const big = planContextWindow({
      turns: turns(40, 40, 5),
      currentInputChars: 0,
      currentStart: 5,
      limits,
    });
    expect(decideContextWindow({ ...base, plan: big, coverage: null })).toMatchObject({
      action: 'forced',
      startTurn: big.startTurn,
    });
    expect(decideContextWindow({ ...base, coverage: null })).toMatchObject({ action: 'wait' });
    expect(decideContextWindow({ ...base, memoryEnabled: false, coverage: 0 })).toMatchObject({
      action: 'advance',
      startTurn: 20,
    });
  });
});

describe('awaitStoryMemory', () => {
  it('never waits longer than the extra-wait cap for a slow read', async () => {
    vi.useFakeTimers();
    try {
      const pending = awaitStoryMemory(new Promise(() => undefined));
      vi.advanceTimersByTime(STORY_MEMORY_MAX_EXTRA_WAIT_MS);
      await expect(pending).resolves.toMatchObject({
        content: null,
        coveredEndTurn: null,
        outcome: 'late',
      });
    } finally {
      vi.useRealTimers();
    }
    expect(STORY_MEMORY_MAX_EXTRA_WAIT_MS).toBeLessThanOrEqual(100);
  });
});

describe('text helpers', () => {
  it('counts body characters only, without whitespace or rich reply panels', () => {
    expect(countChars('你好 world\n')).toBe(7);
    const reply = '正文内容。\n\n[choices][choice]甲[/choice][/choices]\n[status]面板[/status]';
    expect(turnBodyChars({ turnIndex: 1, userInput: '走', assistantReply: reply })).toBe(6);
  });

  it('strips turn labels in all supported shapes', () => {
    expect(stripTurnLabels('甲出场 (T3)。乙离开（T5-T9）。丙 (T2、T4)')).toBe('甲出场。乙离开。丙');
    expect(renderStoryMemoryBlock('甲 (T1)')).toMatch(/^前情提要：.*\n\n甲$/);
  });

  it('renders turns with body only and substitutes placeholders once', () => {
    const rendered = renderTurnsForCompression(
      [{ turnIndex: 7, userInput: '{{user}}推门', assistantReply: '门开了。\n[status]x[/status]' }],
      '林'
    );
    expect(rendered).toBe('[T7]\n【林的输入】\n林推门\n【故事正文】\n门开了。');
    expect(renderPromptTemplate('A{{x}}B{{y}}', { x: '{{y}}', y: '!' })).toBe('A{{y}}B!');
  });

  it('chunks on turn boundaries', () => {
    const story = [1, 2, 3].map((turnIndex) => ({
      turnIndex,
      userInput: '',
      assistantReply: '字'.repeat(40),
    }));
    expect(chunkTurns(story, 100).map((chunk) => chunk.map((t) => t.turnIndex))).toEqual([
      [1, 2],
      [3],
    ]);
  });
});

describe('validateStoryMemory', () => {
  const sections = extractStoryMemorySections(DEFAULT_STORY_MEMORY_PROMPT);
  const full = sections.map((section) => `${section}\n- 内容`).join('\n\n');

  it('extracts the seven output sections from the default prompt', () => {
    expect(sections).toHaveLength(7);
    expect(StoryMemoryPromptSchema.safeParse(DEFAULT_STORY_MEMORY_PROMPT).success).toBe(true);
  });

  it('accepts a complete archive and strips a code fence', () => {
    const result = validateStoryMemory({
      output: '```markdown\n' + full + '\n```',
      sections,
      maxChars: 5000,
      oldMemory: null,
    });
    expect(result).toEqual({ ok: true, content: full });
  });

  it('rejects missing sections, thinking, over-length and abnormal shrink', () => {
    const base = { sections, maxChars: 5000, oldMemory: null };
    expect(validateStoryMemory({ ...base, output: sections[0]! })).toEqual({
      ok: false,
      reason: 'missing_section',
    });
    expect(validateStoryMemory({ ...base, output: '<think>x</think>' + full })).toEqual({
      ok: false,
      reason: 'thinking',
    });
    expect(validateStoryMemory({ ...base, maxChars: 20, output: full })).toEqual({
      ok: false,
      reason: 'too_long',
    });
    const oldMemory = full + '\n' + '旧'.repeat(1500);
    expect(validateStoryMemory({ ...base, oldMemory, output: full })).toEqual({
      ok: false,
      reason: 'shrink',
    });
    // Near the cap the model must compress early plot; shrinking is expected there.
    expect(validateStoryMemory({ ...base, maxChars: 1700, oldMemory, output: full }).ok).toBe(true);
  });
});

describe('story memory config schema', () => {
  it('accepts defaults and rejects unsafe watermarks', () => {
    expect(StoryMemoryConfigSchema.safeParse(DEFAULT_STORY_MEMORY_CONFIG).success).toBe(true);
    expect(
      StoryMemoryConfigSchema.safeParse({
        ...DEFAULT_STORY_MEMORY_CONFIG,
        low_watermark_chars: DEFAULT_STORY_MEMORY_CONFIG.high_watermark_chars,
      }).success
    ).toBe(false);
    expect(
      StoryMemoryConfigSchema.safeParse({ ...DEFAULT_STORY_MEMORY_CONFIG, min_keep_turns: 10 })
        .success
    ).toBe(false);
  });
});
