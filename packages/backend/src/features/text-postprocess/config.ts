import { TEXT_POSTPROCESS_POLICY_VERSION, TEXT_POSTPROCESS_SCHEMA_VERSION } from '@miniapp/shared';
import {
  fetchRuntimeConfigEntryStrict,
  type RuntimeConfigEntry,
} from '../../platform/runtime-config.js';
import { TEXT_POSTPROCESS_CONFIG_KEY, TEXT_POSTPROCESS_CONFIG_TIMEOUT_MS } from './constants.js';

type VersionReader = (key: string, signal?: AbortSignal) => Promise<RuntimeConfigEntry | null>;

/**
 * Admin 读取当前指针。对话开轮不再调用此函数；版本正确性由数据库开轮事务保证。
 * 失败和超时抛出，避免把数据库故障显示成“尚未发布”。
 */
export async function readAdminPostprocessVersion(
  timeoutMs = TEXT_POSTPROCESS_CONFIG_TIMEOUT_MS,
  read: VersionReader = fetchRuntimeConfigEntryStrict
): Promise<number | null> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const entry = await Promise.race([
      read(TEXT_POSTPROCESS_CONFIG_KEY, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new DOMException('Text postprocess config timed out', 'TimeoutError');
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
    if (!entry) return null;
    return publishedVersion(entry);
  } finally {
    if (timeout) clearTimeout(timeout);
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
