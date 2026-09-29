import { TEXT_POSTPROCESS_POLICY_VERSION, TEXT_POSTPROCESS_SCHEMA_VERSION } from '@miniapp/shared';
import {
  fetchRuntimeConfigEntry,
  fetchRuntimeConfigEntryStrict,
  type RuntimeConfigEntry,
} from '../../platform/runtime-config.js';
import { TEXT_POSTPROCESS_CONFIG_KEY, TEXT_POSTPROCESS_CONFIG_TIMEOUT_MS } from './constants.js';

export interface ReadCurrentPostprocessVersionOptions {
  timeoutMs?: number;
  read?: (key: string) => Promise<RuntimeConfigEntry | null>;
}

/**
 * 开轮前只读一次当前已发布版本。
 * 缺失、非法、超时、未知 schema/policy，或配置列与值里的版本不一致时返回 null。
 * 不查询历史快照，也不用最大版本顶替。
 */
export async function readCurrentPostprocessVersion(
  options: ReadCurrentPostprocessVersionOptions = {}
): Promise<number | null> {
  const timeoutMs = options.timeoutMs ?? TEXT_POSTPROCESS_CONFIG_TIMEOUT_MS;
  const read = options.read ?? fetchRuntimeConfigEntry;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const entry = await Promise.race([
      read(TEXT_POSTPROCESS_CONFIG_KEY),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (!entry) return null;
    return publishedVersion(entry);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Admin 读取当前指针。失败和超时抛出，避免把数据库故障显示成“尚未发布”。
 * 值本身非法时返回 null，不用别的快照顶上。
 */
export async function readAdminPostprocessVersion(
  timeoutMs = TEXT_POSTPROCESS_CONFIG_TIMEOUT_MS,
  read: (key: string) => Promise<RuntimeConfigEntry | null> = fetchRuntimeConfigEntryStrict
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const entry = await Promise.race([
      read(TEXT_POSTPROCESS_CONFIG_KEY),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('text postprocess config read timed out')),
          timeoutMs
        );
      }),
    ]);
    if (!entry) return null;
    return publishedVersion(entry);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function publishedVersion(entry: RuntimeConfigEntry): number | null {
  if (!entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) return null;
  const value = entry.value as Record<string, unknown>;
  const version = value.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  if (value.schema_version !== TEXT_POSTPROCESS_SCHEMA_VERSION) return null;
  if (value.policy_version !== TEXT_POSTPROCESS_POLICY_VERSION) return null;
  if (entry.version !== version) return null;
  return version;
}
