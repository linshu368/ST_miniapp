import { TEXT_POSTPROCESS_POLICY_VERSION, TEXT_POSTPROCESS_SCHEMA_VERSION } from '@miniapp/shared';
import { createLogger } from '../../lib/logger.js';
import {
  fetchRuntimeConfigEntryStrict,
  type RuntimeConfigEntry,
} from '../../platform/runtime-config.js';
import {
  TEXT_POSTPROCESS_CONFIG_KEY,
  TEXT_POSTPROCESS_CONFIG_REFRESH_INTERVAL_MS,
  TEXT_POSTPROCESS_CONFIG_TIMEOUT_MS,
  TEXT_POSTPROCESS_CONFIG_WARMUP_TIMEOUT_MS,
} from './constants.js';

type VersionReader = (key: string, signal?: AbortSignal) => Promise<RuntimeConfigEntry | null>;
type RefreshReason = 'startup' | 'interval' | 'manual';

interface CachedVersion {
  version: number | null;
  refreshedAt: number;
}

export interface TextPostprocessVersionCacheOptions {
  read?: VersionReader;
  now?: () => number;
  timeoutMs?: number;
  refreshIntervalMs?: number;
}

const log = createLogger('text-postprocess-config');

/**
 * 富文本只是展示增强：用户请求只读内存，数据库刷新永远在启动或后台完成。
 * 刷新失败保留最近一次已验证快照；没有快照时静默回到原 Markdown。
 */
export class TextPostprocessVersionCache {
  private readonly read: VersionReader;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly refreshIntervalMs: number;
  private cached: CachedVersion | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TextPostprocessVersionCacheOptions = {}) {
    this.read = options.read ?? fetchRuntimeConfigEntryStrict;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? TEXT_POSTPROCESS_CONFIG_WARMUP_TIMEOUT_MS;
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? TEXT_POSTPROCESS_CONFIG_REFRESH_INTERVAL_MS;
  }

  current(): number | null {
    return this.cached?.version ?? null;
  }

  prime(version: number): void {
    if (!Number.isInteger(version) || version < 1) return;
    this.cached = { version, refreshedAt: this.now() };
  }

  async warm(): Promise<number | null> {
    await this.refresh('startup');
    return this.current();
  }

  start(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.refresh('interval');
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  refresh(reason: RefreshReason = 'manual'): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const work = this.load(reason).finally(() => {
      if (this.refreshPromise === work) this.refreshPromise = null;
    });
    this.refreshPromise = work;
    return work;
  }

  reset(): void {
    this.stop();
    this.cached = null;
    this.refreshPromise = null;
  }

  private async load(reason: RefreshReason): Promise<void> {
    const startedAt = this.now();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const entry = await Promise.race([
        this.read(TEXT_POSTPROCESS_CONFIG_KEY, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new DOMException('Text postprocess config timed out', 'TimeoutError');
            controller.abort(error);
            reject(error);
          }, this.timeoutMs);
        }),
      ]);
      if (!entry) {
        this.cached = { version: null, refreshedAt: this.now() };
        return;
      }
      const version = publishedVersion(entry);
      if (version === null) {
        log.warn(
          {
            event: 'text_postprocess.config.invalid',
            reason,
            durationMs: this.now() - startedAt,
            hasCachedVersion: this.cached !== null,
          },
          '富文本正式版本配置非法，继续使用最近有效展示版本'
        );
        return;
      }
      const previous = this.cached?.version;
      this.cached = { version, refreshedAt: this.now() };
      if (reason === 'startup' || previous !== version) {
        log.info(
          {
            event: 'text_postprocess.config.refreshed',
            reason,
            version,
            durationMs: this.now() - startedAt,
          },
          '富文本正式版本缓存已更新'
        );
      }
    } catch (err) {
      log.warn(
        {
          event: 'text_postprocess.config.refresh_failed',
          err,
          reason,
          timedOut: controller.signal.aborted,
          durationMs: this.now() - startedAt,
          cachedVersion: this.cached?.version ?? null,
        },
        '富文本正式版本刷新失败，聊天继续使用现有展示降级'
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

const currentVersionCache = new TextPostprocessVersionCache();

/** 热路径只读内存；保留 Promise 签名避免改变会话准备编排。 */
export async function readCurrentPostprocessVersion(): Promise<number | null> {
  return currentVersionCache.current();
}

export function warmCurrentPostprocessVersion(): Promise<number | null> {
  return currentVersionCache.warm();
}

export function startCurrentPostprocessVersionRefresh(): void {
  currentVersionCache.start();
}

export function stopCurrentPostprocessVersionRefresh(): void {
  currentVersionCache.stop();
}

export function primeCurrentPostprocessVersion(version: number): void {
  currentVersionCache.prime(version);
}

export function resetCurrentPostprocessVersionCacheForTests(): void {
  currentVersionCache.reset();
}

/**
 * Admin 读取当前指针。失败和超时抛出，避免把数据库故障显示成“尚未发布”。
 * 值本身非法时返回 null，不用别的快照顶上。
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
