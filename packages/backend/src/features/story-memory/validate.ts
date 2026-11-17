/**
 * 压缩结果的代码校验。不合格的结果绝不写成新版本，也就不会被注入。
 */
import { countChars } from './text.js';

export type StoryMemoryRejection = 'empty' | 'thinking' | 'missing_section' | 'too_long' | 'shrink';

export type StoryMemoryValidation =
  | { ok: true; content: string }
  | { ok: false; reason: StoryMemoryRejection };

const SHRINK_CHECK_MIN_OLD_CHARS = 800;
/** 旧版接近上限时模型必须压缩早期剧情，此时缩水是正常精简，不检查 */
const SHRINK_CHECK_MAX_FILL = 0.8;
const MIN_RETAINED_RATIO = 0.7;

export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(trimmed);
  return (fenced ? fenced[2]! : trimmed).trim();
}

export function validateStoryMemory(input: {
  output: string;
  sections: string[];
  maxChars: number;
  oldMemory: string | null;
}): StoryMemoryValidation {
  const content = stripCodeFence(input.output);
  if (!content) return { ok: false, reason: 'empty' };
  if (/<\/?think(?:ing)?\b/i.test(content)) return { ok: false, reason: 'thinking' };

  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  if (input.sections.some((section) => !lines.has(section))) {
    return { ok: false, reason: 'missing_section' };
  }

  const chars = countChars(content);
  if (chars > input.maxChars) return { ok: false, reason: 'too_long' };

  const oldChars = input.oldMemory ? countChars(input.oldMemory) : 0;
  if (
    oldChars >= SHRINK_CHECK_MIN_OLD_CHARS &&
    oldChars < input.maxChars * SHRINK_CHECK_MAX_FILL &&
    chars < oldChars * MIN_RETAINED_RATIO
  ) {
    return { ok: false, reason: 'shrink' };
  }
  return { ok: true, content };
}
