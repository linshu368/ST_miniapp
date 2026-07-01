/**
 * sync-engine / registry / loader.ts
 *
 * 职责：从 YAML 文件加载配置清单，通过 Zod schema 做结构型校验，
 * 返回类型安全的 SyncRegistry 对象。
 *
 * 注意：只做结构型校验（字段存在 / 类型正确 / 枚举值合法）。
 * 跨条目的业务规则校验在 validator.ts 中处理。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { ZodError } from 'zod';
import { SyncRegistrySchema } from './schema.js';
import type { SyncRegistry } from './types.js';

// ─── 自定义错误类型 ────────────────────────────────────────────────────────────
export class RegistryLoadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'RegistryLoadError';
  }
}

// ─── 主加载函数 ────────────────────────────────────────────────────────────────
/**
 * 从指定路径加载 registry.yaml，解析并校验后返回 SyncRegistry。
 *
 * @param filePath - YAML 文件路径（绝对路径或相对于 CWD 的相对路径）
 * @returns 类型安全的 SyncRegistry 对象
 * @throws RegistryLoadError 当文件读取失败、YAML 解析失败或 Zod 校验失败时
 */
export function loadRegistry(filePath: string): SyncRegistry {
  const absolutePath = resolve(filePath);

  // 1. 读取文件
  let rawContent: string;
  try {
    rawContent = readFileSync(absolutePath, 'utf-8');
  } catch (err) {
    throw new RegistryLoadError(
      `无法读取清单文件：${absolutePath}\n原因：${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }

  // 2. 解析 YAML
  let parsed: unknown;
  try {
    parsed = yaml.load(rawContent);
  } catch (err) {
    throw new RegistryLoadError(
      `YAML 解析失败：${absolutePath}\n原因：${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new RegistryLoadError(
      `清单文件内容无效：期望一个对象，实际得到 ${parsed === null ? 'null' : typeof parsed}`
    );
  }

  // 3. Zod 结构型校验
  const result = SyncRegistrySchema.safeParse(parsed);
  if (!result.success) {
    const details = formatZodError(result.error);
    throw new RegistryLoadError(`清单结构校验失败：${absolutePath}\n${details}`, result.error);
  }

  return result.data as SyncRegistry;
}

// ─── 辅助：格式化 Zod 错误输出 ────────────────────────────────────────────────
function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `[${issue.path.join('.')}] ` : '';
      return `  ${path}${issue.message}`;
    })
    .join('\n');
}
