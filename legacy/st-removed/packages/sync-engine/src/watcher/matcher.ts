/**
 * sync-engine / watcher / matcher.ts
 *
 * 变更事件 → 清单规则匹配。
 * 给定一个文件变更的相对路径（相对于 data/<handle>/），
 * 从清单中找到匹配的 direction=up 且 trigger 包含 watch 的规则。
 *
 * 设计原则第 6 条：所有同步规则走声明式匹配，不硬编码规则 id。
 */

import { basename, dirname, relative } from 'node:path';
import type { SyncEntry, SyncRegistry } from '../registry/types.js';
import { handleDir } from '../lib/st-fs.js';

/**
 * 从清单中提取所有可被 watch 触发的上行规则（预过滤，启动时调用一次）。
 */
export function extractWatchUpEntries(registry: SyncRegistry): SyncEntry[] {
  return registry.entries.filter(
    (e) => e.direction === 'up' && e.enabled && e.triggers.includes('watch')
  );
}

/**
 * 给定变更文件的绝对路径和 handle，从上行规则列表中匹配命中的规则。
 *
 * @param upEntries    - extractWatchUpEntries() 的返回值
 * @param handle       - ST 用户 handle
 * @param changedPath  - 变更文件的绝对路径
 * @returns 匹配到的 SyncEntry，或 null（无匹配则不触发同步）
 */
export function matchEntry(
  upEntries: SyncEntry[],
  handle: string,
  changedPath: string
): SyncEntry | null {
  const userDir = handleDir(handle);
  const relPath = relative(userDir, changedPath);

  for (const entry of upEntries) {
    if (entry.st.type === 'json_field') {
      // json_field 匹配：相对路径 === st.file（如 'settings.json'）
      if (relPath === entry.st.file) return entry;
    } else if (entry.st.type === 'asset_file') {
      // asset_file 匹配：变更文件所在目录 === st.directory
      const dir = dirname(relPath);
      if (dir === entry.st.directory) return entry;
    }
  }

  return null;
}
