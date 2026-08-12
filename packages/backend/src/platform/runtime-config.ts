/**
 * backend / platform / runtime-config.ts
 *
 * miniapp.runtime_config 的统一读取入口。
 *
 * 实现原样来自 model-tiers.ts（llm_model_catalog / llm_pricing_config 的读法），M2 需要读
 * 平台规则三件套时提取到这里共用，避免同一张表长出第二套读法。调用方各自负责校验、缓存
 * 与兜底——version 字段就是给缓存判活用的（见 shouldReuseCatalogCache）。
 */

import { getSupabaseClient } from '../lib/supabase.js';

export interface RuntimeConfigEntry {
  value: unknown;
  /** 长文本类配置存这一列，JSON 类配置为 NULL（见 migrations 019 / 057 / 071 的存法） */
  textValue: string | null;
  version: number;
}

const SELECT_COLUMNS = 'key,value,text_value,version';

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

export async function fetchRuntimeConfigEntry(key: string): Promise<RuntimeConfigEntry | null> {
  const db = getSupabaseClient().schema('miniapp');
  const { data, error } = await db
    .from('runtime_config')
    .select(SELECT_COLUMNS)
    .eq('key', key)
    .maybeSingle();

  if (error) {
    console.error(`[runtime-config] Failed to fetch ${key}:`, error);
    return null;
  }
  if (!data) return null;
  return toEntry(data);
}

export async function fetchRuntimeConfigValue(key: string): Promise<unknown | null> {
  const entry = await fetchRuntimeConfigEntry(key);
  return entry?.value ?? null;
}

/**
 * 一次取多个 key，缺失的 key 不出现在返回的 Map 里。
 * 热路径上要同时读三个平台规则 key，逐个查会多两个往返。
 */
export async function fetchRuntimeConfigEntries(
  keys: readonly string[]
): Promise<Map<string, RuntimeConfigEntry>> {
  const db = getSupabaseClient().schema('miniapp');
  const { data, error } = await db.from('runtime_config').select(SELECT_COLUMNS).in('key', keys);

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
