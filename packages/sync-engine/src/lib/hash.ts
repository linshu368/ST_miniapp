/**
 * sync-engine / lib / hash.ts
 *
 * Canonical JSON 序列化 + SHA-256 content hash。
 * provisioner（首次写入 B 表）和 watcher（反向同步去重）共用。
 *
 * 为什么不用 JSON.stringify 直接算 hash：
 *   PG jsonb 的 key 顺序不稳定，JS 对象的 key 插入顺序也不保证语义顺序。
 *   两次语义相同但 key 顺序不同的 jsonb 会产生不同 hash，去重失效。
 *   canonical = 递归排序所有 key 后再 stringify，确保同值同 hash。
 */

import { createHash } from 'node:crypto';

/**
 * 递归排序对象所有层级的 key，返回一个 key 有序的新对象。
 * 数组内的元素保持原始顺序（数组是有序结构，不排序）。
 * 原始值直接返回。
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * 计算对象的 canonical content hash（SHA-256 hex）。
 * 流程：canonicalize → JSON.stringify → SHA-256
 */
export function computeContentHash(obj: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalize(obj));
  return createHash('sha256').update(canonical).digest('hex');
}
