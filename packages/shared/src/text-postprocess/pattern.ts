import { TEXT_POSTPROCESS_CAPTURE_NAME } from '../api/text-postprocess';

export interface PatternGroups {
  count: number;
  names: string[];
  name_by_index: Array<string | null>;
}

export type PatternInspection =
  | { ok: true; groups: PatternGroups }
  | { ok: false; code: 'INVALID_PATTERN' | 'EMPTY_MATCH' };

/**
 * 捕获组编号以正则字面量扫描为准，再用引擎对空串的探测结果核对。
 * 不在用户正文上执行，避免把分组发现变成一次无界匹配。
 */
export function inspectPattern(pattern: string, flags: string): PatternInspection {
  const scanned = scanGroups(pattern);
  if (!scanned) return { ok: false, code: 'INVALID_PATTERN' };
  const flagsWithoutGlobal = flags.replace(/g/g, '');
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, flagsWithoutGlobal);
    const probe = new RegExp(`(?:${pattern})|`, flagsWithoutGlobal);
    const match = probe.exec('');
    const probedNames = match?.groups ? Object.keys(match.groups) : [];
    if (!match || match.length - 1 !== scanned.count) return { ok: false, code: 'INVALID_PATTERN' };
    if (probedNames.length !== scanned.names.length) return { ok: false, code: 'INVALID_PATTERN' };
    if (scanned.names.some((name) => !probedNames.includes(name))) {
      return { ok: false, code: 'INVALID_PATTERN' };
    }
    if (expression.test('')) return { ok: false, code: 'EMPTY_MATCH' };
  } catch {
    return { ok: false, code: 'INVALID_PATTERN' };
  }
  return { ok: true, groups: scanned };
}

function scanGroups(pattern: string): PatternGroups | null {
  let count = 0;
  const nameByIndex: Array<string | null> = [];
  let index = 0;
  let inClass = false;
  while (index < pattern.length) {
    const char = pattern[index];
    if (inClass) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === ']') inClass = false;
      index += 1;
      continue;
    }
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '[') {
      inClass = true;
      index += 1;
      continue;
    }
    if (char !== '(') {
      index += 1;
      continue;
    }
    if (
      pattern.startsWith('(?:', index) ||
      pattern.startsWith('(?=', index) ||
      pattern.startsWith('(?!', index)
    ) {
      index += 3;
      continue;
    }
    if (pattern.startsWith('(?<=', index) || pattern.startsWith('(?<!', index)) {
      index += 4;
      continue;
    }
    if (pattern.startsWith('(?<', index)) {
      const close = pattern.indexOf('>', index + 3);
      if (close < 0) return null;
      const name = pattern.slice(index + 3, close);
      if (!TEXT_POSTPROCESS_CAPTURE_NAME.test(name) || nameByIndex.includes(name)) return null;
      count += 1;
      nameByIndex.push(name);
      index = close + 1;
      continue;
    }
    if (pattern[index + 1] === '?') return null;
    count += 1;
    nameByIndex.push(null);
    index += 1;
  }
  if (count > 99) return null;
  return {
    count,
    names: nameByIndex.filter((name): name is string => name !== null),
    name_by_index: nameByIndex,
  };
}
