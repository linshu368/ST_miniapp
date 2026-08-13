/**
 * backend / features / conversations / context-window.ts
 *
 * 自研引擎入模历史的双水位线。Postgres 记窗口起点，这里只负责：
 *   - 读 runtime_config 的 A/B 并做缺省/非法兜底
 *   - 复述泄洪公式，供单测锁死跳点（真正写起点的是开轮 RPC）
 *
 * 详见 docs/context-window-and-prompt-cache.md。
 */

import {
  fetchRuntimeConfigEntries,
  type RuntimeConfigEntry,
} from '../../platform/runtime-config.js';

/** 高水位 B：入模窗口最多带最近这么多轮 */
export const MAX_CONTEXT_TURNS_KEY = 'max_context_turns';
/** 低水位 A：泄洪后留下最近这么多轮 */
export const RETAIN_CONTEXT_TURNS_KEY = 'retain_context_turns';

export const DEFAULT_MAX_CONTEXT_TURNS = 75;
export const DEFAULT_RETAIN_CONTEXT_TURNS = 50;

const CONFIG_KEYS = [MAX_CONTEXT_TURNS_KEY, RETAIN_CONTEXT_TURNS_KEY] as const;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface ContextWindowLimits {
  /** B */
  maxTurns: number;
  /** A */
  retainTurns: number;
}

let cached: ContextWindowLimits | null = null;
let cachedVersionSignature = '';
let lastFetchTime = 0;

function parsePositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

/**
 * 缺省或非法回落到代码默认值，并保证 1 ≤ A ≤ B。
 * A=B 时退化为滑动窗口，cache 收益变差，但是合法配置。
 */
export function resolveContextWindowLimits(
  maxRaw: unknown,
  retainRaw: unknown
): ContextWindowLimits {
  const maxTurns = parsePositiveInt(maxRaw) ?? DEFAULT_MAX_CONTEXT_TURNS;
  let retainTurns = parsePositiveInt(retainRaw) ?? DEFAULT_RETAIN_CONTEXT_TURNS;
  if (retainTurns > maxTurns) retainTurns = maxTurns;
  return { maxTurns, retainTurns };
}

/**
 * 窗口超过 B 时一次性收到最近 A 轮；未超则起点不动。
 * completedTurns = 本轮 turn_index - 1（本轮之前已完成的轮数）。
 */
export function nextContextWindowStartTurn(input: {
  currentStart: number;
  completedTurns: number;
  maxTurns: number;
  retainTurns: number;
}): number {
  const start = Math.max(input.currentStart, 1);
  const size = input.completedTurns - start + 1;
  if (input.completedTurns <= 0 || size <= input.maxTurns) return start;
  return input.completedTurns - input.retainTurns + 1;
}

function versionSignature(entries: Map<string, RuntimeConfigEntry>): string {
  return CONFIG_KEYS.map((key) => `${key}:${entries.get(key)?.version ?? -1}`).join('|');
}

export async function fetchContextWindowLimits(): Promise<ContextWindowLimits> {
  let entries: Map<string, RuntimeConfigEntry>;
  try {
    entries = await fetchRuntimeConfigEntries(CONFIG_KEYS);
  } catch (error) {
    console.error('[context-window] 读取水位线配置失败，使用代码默认值:', error);
    return cached ?? resolveContextWindowLimits(null, null);
  }

  const signature = versionSignature(entries);
  if (cached && signature === cachedVersionSignature) return cached;
  if (cached && entries.size === 0 && Date.now() - lastFetchTime < CACHE_TTL_MS) return cached;

  cached = resolveContextWindowLimits(
    entries.get(MAX_CONTEXT_TURNS_KEY)?.value,
    entries.get(RETAIN_CONTEXT_TURNS_KEY)?.value
  );
  cachedVersionSignature = signature;
  lastFetchTime = Date.now();
  return cached;
}

export function invalidateContextWindowCache(): void {
  cached = null;
  cachedVersionSignature = '';
  lastFetchTime = 0;
}
