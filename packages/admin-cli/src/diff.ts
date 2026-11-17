/**
 * 发布前给人和 AI 看的差异：按 JSON 路径列出增删改。长文本按行比较，只列出变化的行。
 * 不追求最小编辑距离，只要变化位置准确、输出有界。
 */

export type DiffEntry =
  | { path: string; kind: 'added'; after: unknown }
  | { path: string; kind: 'removed'; before: unknown }
  | { path: string; kind: 'changed'; before: unknown; after: unknown }
  | { path: string; kind: 'text'; lines: string[] };

const LONG_TEXT_CHARS = 120;
const MAX_TEXT_DIFF_LINES = 200;

export function diffValues(before: unknown, after: unknown, path = ''): DiffEntry[] {
  if (deepEqual(before, after)) return [];
  if (typeof before === 'string' && typeof after === 'string' && isLongText(before, after)) {
    return [{ path: path || '(值)', kind: 'text', lines: diffLines(before, after) }];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const entries: DiffEntry[] = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const childPath = `${path}[${index}]`;
      if (index >= before.length)
        entries.push({ path: childPath, kind: 'added', after: after[index] });
      else if (index >= after.length)
        entries.push({ path: childPath, kind: 'removed', before: before[index] });
      else entries.push(...diffValues(before[index], after[index], childPath));
    }
    return entries;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const entries: DiffEntry[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in before)) entries.push({ path: childPath, kind: 'added', after: after[key] });
      else if (!(key in after))
        entries.push({ path: childPath, kind: 'removed', before: before[key] });
      else entries.push(...diffValues(before[key], after[key], childPath));
    }
    return entries;
  }
  return [{ path: path || '(值)', kind: 'changed', before, after }];
}

export function formatDiff(entries: DiffEntry[]): string {
  if (entries.length === 0) return '（无差异）';
  const show = (value: unknown) => JSON.stringify(value);
  return entries
    .map((entry) => {
      switch (entry.kind) {
        case 'added':
          return `+ ${entry.path}: ${show(entry.after)}`;
        case 'removed':
          return `- ${entry.path}: ${show(entry.before)}`;
        case 'changed':
          return `~ ${entry.path}: ${show(entry.before)} → ${show(entry.after)}`;
        case 'text':
          return [`~ ${entry.path}（文本）:`, ...entry.lines.map((line) => `    ${line}`)].join(
            '\n'
          );
      }
    })
    .join('\n');
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLongText(before: string, after: string): boolean {
  return (
    before.includes('\n') ||
    after.includes('\n') ||
    before.length > LONG_TEXT_CHARS ||
    after.length > LONG_TEXT_CHARS
  );
}

/** 基于最长公共子序列的行差异；行数过多时退化为首尾比较，保证耗时有界。 */
function diffLines(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) {
    return [`（文本过长，仅提示变化：${a.length} 行 → ${b.length} 行）`];
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push(`+ L${j + 1}: ${b[j]}`);
      j += 1;
    } else {
      out.push(`- L${i + 1}: ${a[i]}`);
      i += 1;
    }
    if (out.length >= MAX_TEXT_DIFF_LINES) {
      out.push('…（差异行过多，已截断）');
      break;
    }
  }
  return out;
}
