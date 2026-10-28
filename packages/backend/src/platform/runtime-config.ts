/**
 * backend / platform / runtime-config.ts
 *
 * app_core.runtime_config 的统一读取入口。
 *
 * 实现原样来自 model-tiers.ts（llm_model_catalog / llm_pricing_config 的读法），M2 需要读
 * 平台规则三件套时提取到这里共用，避免同一张表长出第二套读法。调用方各自负责校验、缓存
 * 与兜底——version 字段就是给缓存判活用的（见 shouldReuseCatalogCache）。
 */

import { getDomainDb } from '../lib/supabase.js';
import { config } from './config.js';
import type { DramaCdnConfig } from '../features/drama/cdn-experiment.js';

/** Deployment-only, closed by default and impossible to enable on stable TEST/production. */
export function getDramaCdnExperimentConfig(): DramaCdnConfig {
  return {
    enabled:
      process.env.DRAMA_CDN_EXPERIMENT_ENABLED === 'true' &&
      /^pr-\d+$/.test(process.env.RAILWAY_ENVIRONMENT_NAME ?? '') &&
      config.database.target === 'test' &&
      process.env.DEV_AUTH_BYPASS !== '1' &&
      process.env.MOCK_AUTH !== '1',
    userIds: (process.env.DRAMA_CDN_EXPERIMENT_USER_IDS ?? '')
      .split(',')
      .filter((id) => /^[1-9]\d{0,14}$/.test(id.trim()))
      .map((id) => Number(id.trim())),
    sourceUrl: process.env.DRAMA_CDN_EXPERIMENT_SOURCE_URL ?? '',
    tokenKey: process.env.DRAMA_CDN_EXPERIMENT_TOKEN_KEY ?? '',
    deadlineMs: Date.parse(process.env.DRAMA_CDN_EXPERIMENT_DEADLINE ?? ''),
  };
}

/** Deployment opt-in: a compatible backend may ship before the manual analytics migration. */
export function getDramaTimingPersistenceConfig() {
  const candidate = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SENTRY_RELEASE || 'unknown';
  return {
    enabled: process.env.DRAMA_TIMING_PERSIST_ENABLED === 'true',
    environment: config.database.target,
    release: /^[a-zA-Z0-9_.-]{1,128}$/.test(candidate) ? candidate : 'unknown',
  };
}

export interface LlmProviderRuntimeConfig {
  baseUrl: string;
  apiKey: string;
}

/** Provider credentials stay in backend runtime config; catalogs only store public provider IDs. */
export function getLlmProviderRuntimeConfig(
  provider: 'openrouter' | 'venice'
): LlmProviderRuntimeConfig {
  if (provider === 'openrouter') {
    return {
      baseUrl: process.env.LLM_UPSTREAM_URL || 'https://openrouter.ai/api/v1',
      apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    };
  }
  return {
    baseUrl: process.env.VENICE_API_BASE_URL || 'https://api.venice.ai/api/v1',
    apiKey: process.env.VENICE_API_KEY || '',
  };
}

export interface RuntimeConfigEntry {
  value: unknown;
  /** 长文本类配置存这一列，JSON 类配置为 NULL（见 migrations 019 / 057 / 071 的存法） */
  textValue: string | null;
  version: number;
}

const SELECT_COLUMNS = 'key,value,text_value,version';
const HOT_READ_TIMEOUT_MS = 5_000;
const entryInflight = new Map<string, Promise<RuntimeConfigEntry | null>>();
const entriesInflight = new Map<string, Promise<Map<string, RuntimeConfigEntry>>>();

function toEntry(row: {
  value: unknown;
  text_value: unknown;
  version: unknown;
}): RuntimeConfigEntry {
  return {
    value: row.value,
    textValue: typeof row.text_value === 'string' ? row.text_value : null,
    version: typeof row.version === 'number' ? row.version : 0,
  };
}

export class RuntimeConfigReadError extends Error {
  readonly key: string;

  constructor(key: string, cause: unknown) {
    super(`runtime config read failed: ${key}`);
    this.name = 'RuntimeConfigReadError';
    this.key = key;
    this.cause = cause;
  }
}

/**
 * 读取失败时抛出，而不是当成缺失。提醒写入用它做 fail closed，
 * 避免把数据库故障误读成“开关不存在所以关闭”之外还吞掉原始错误。
 */
export async function fetchRuntimeConfigEntryStrict(
  key: string,
  signal?: AbortSignal
): Promise<RuntimeConfigEntry | null> {
  const db = getDomainDb('app_core');
  const request = db.from('runtime_config').select(SELECT_COLUMNS).eq('key', key);
  const bounded = signal ? request.abortSignal(signal) : request;
  const { data, error } = await bounded.maybeSingle();

  if (error) throw new RuntimeConfigReadError(key, error);
  if (!data) return null;
  return toEntry(data);
}

export async function fetchRuntimeConfigEntry(
  key: string,
  signal?: AbortSignal
): Promise<RuntimeConfigEntry | null> {
  // 调用方自带 signal 时必须保持取消隔离，不能让一个请求中止其他消费者。
  if (signal) return fetchRuntimeConfigEntryDirect(key, signal);

  const running = entryInflight.get(key);
  if (running) return running;

  const promise = fetchRuntimeConfigEntryDirect(key).finally(() => {
    if (entryInflight.get(key) === promise) entryInflight.delete(key);
  });
  entryInflight.set(key, promise);
  return promise;
}

async function fetchRuntimeConfigEntryDirect(
  key: string,
  signal?: AbortSignal
): Promise<RuntimeConfigEntry | null> {
  const db = getDomainDb('app_core');
  const request = db.from('runtime_config').select(SELECT_COLUMNS).eq('key', key);
  const bounded = signal ? request.abortSignal(signal) : request;
  const { data, error } = await bounded.maybeSingle();

  if (error) {
    console.error(`[runtime-config] Failed to fetch ${key}:`, error);
    return null;
  }
  if (!data) return null;
  return toEntry(data);
}

/**
 * 一次取多个 key，缺失的 key 不出现在返回的 Map 里。
 * 热路径上要同时读三个平台规则 key，逐个查会多两个往返。
 *
 * 默认 5s 上限：这是几乎每个生成/计费请求都会走的读，失败时本就返回空 Map 由调用方兜底，
 * 快速失败远好于跟着 PostgREST 挂死一起等几十秒。
 */
export async function fetchRuntimeConfigEntries(
  keys: readonly string[],
  signal?: AbortSignal
): Promise<Map<string, RuntimeConfigEntry>> {
  const normalizedKeys = [...new Set(keys)].sort();
  if (normalizedKeys.length === 0) return new Map();
  if (signal) return fetchRuntimeConfigEntriesDirect(normalizedKeys, signal);

  const signature = normalizedKeys.join('\u0000');
  const running = entriesInflight.get(signature);
  if (running) return new Map(await running);

  const promise = fetchRuntimeConfigEntriesDirect(
    normalizedKeys,
    AbortSignal.timeout(HOT_READ_TIMEOUT_MS)
  ).finally(() => {
    if (entriesInflight.get(signature) === promise) entriesInflight.delete(signature);
  });
  entriesInflight.set(signature, promise);
  return new Map(await promise);
}

async function fetchRuntimeConfigEntriesDirect(
  keys: readonly string[],
  signal: AbortSignal
): Promise<Map<string, RuntimeConfigEntry>> {
  const db = getDomainDb('app_core');
  const { data, error } = await db
    .from('runtime_config')
    .select(SELECT_COLUMNS)
    .in('key', keys)
    .abortSignal(signal);

  if (error) {
    console.error(`[runtime-config] Failed to fetch ${keys.join(' / ')}:`, error);
    return new Map();
  }

  const entries = new Map<string, RuntimeConfigEntry>();
  for (const row of data ?? []) {
    if (typeof row.key !== 'string') continue;
    entries.set(row.key, toEntry(row));
  }
  return entries;
}

/** 测试与显式恢复入口；只清理在途引用，不缓存任何配置结果。 */
export function clearRuntimeConfigInflightReads(): void {
  entryInflight.clear();
  entriesInflight.clear();
}
