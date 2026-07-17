/**
 * sync-engine / provisioner / fetcher.ts
 *
 * 从 Supabase 拉取 provisioner 所需的全部数据。
 * 职责：纯数据拉取，不做任何转换逻辑。
 */

import { getSupabaseClient, schemaClient } from '../lib/supabase.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../lib/config.js';
import { resolveProvisionModel } from './model-resolution.js';

// ─── 数据类型定义 ──────────────────────────────────────────────────────────────

export interface CharacterRow {
  id: string;
  name: string;
  enabled: boolean;
  sort_order: number;
  description: string | null;
  personality: string | null;
  scenario: string | null;
  first_mes: string | null;
  mes_example: string | null;
  creator_notes: string | null;
  system_prompt: string | null;
  post_history_instructions: string | null;
  alternate_greetings: unknown;
  tags: unknown;
  character_book: unknown;
  extensions: unknown;
  creator: string | null;
  character_version: string | null;
  spec: string | null;
  spec_version: string | null;
}

export interface PresetRow {
  id: string;
  display_name: string;
  preset_payload: Record<string, unknown>;
  is_default: boolean;
}

export interface PlatformSettingsRow {
  platform_version: number;
  settings_jsonb: Record<string, unknown>;
  writable_paths: Array<{ path: string; transform: string }>;
}

export interface UserSettingsRow {
  user_revision: number;
  settings_jsonb: Record<string, unknown>;
  based_on_platform_version: number;
}

export interface ApiConfigRow {
  id: string;
  config_payload: {
    provider: string; // 对应 ST secrets.json 的 key 前缀，如 "openrouter"
    api_key: string; // [SENSITIVE] 明文 key，永远不返回客户端
    api_base_url?: string;
    model?: string;
    model_whitelist?: string[];
  };
  is_default: boolean;
}

/**
 * 用户 ST persona（对话页显示的「用户名 + 头像」）。
 * 来源：miniapp.miniapp_user_settings（Bridge 登录时按 TG initData 落库）。
 * 无可用 TG 身份时使用平台默认 persona。
 */
export interface UserPersona {
  /** 显示名：display_name || tg_first_name(+ tg_last_name) || tg_username */
  name: string | null;
  /** 头像源 URL：avatar_url（== TG photo_url 或用户自定义），可为空 */
  avatarUrl: string | null;
}

export interface ProvisionData {
  /** 用户 st_handle，从 users 表读取 */
  stHandle: string;
  /** 分区 A：上架中的平台角色卡列表（enabled=true，按 sort_order 排序） */
  characters: CharacterRow[];
  /** 分区 A：enabled 的平台预设列表 */
  presets: PresetRow[];
  /** 分区 A：最新版本的平台 settings */
  platformSettings: PlatformSettingsRow;
  /** 分区 A：is_default=true 的平台 API 配置（用于写 secrets.json） */
  apiConfig: ApiConfigRow | null;
  /** 分区 B：该用户最新的 settings 镜像（可能为 null，表示新用户）  */
  userSettings: UserSettingsRow | null;
  /** 系统兜底卡 ID（character_ref 失效时的回退值），来自 runtime_config */
  systemFallbackCharacterId: string | null;
  /** 用户 ST persona（TG 名字/头像），name 为空表示无可用身份 */
  userPersona: UserPersona;
  /** 用户有效选择对应的 OpenRouter 模型；无有效选择时使用目录默认模型。 */
  defaultLlmModel: string | null;
}

export const DEFAULT_USER_PERSONA_NAME = '用户';

// ─── 错误类型 ──────────────────────────────────────────────────────────────────
export class FetchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

// ─── 主拉取函数 ────────────────────────────────────────────────────────────────
export async function fetchProvisionData(userId: string): Promise<ProvisionData> {
  const db = getSupabaseClient();

  // 并行拉取所有数据（users 查询需要先拿到 handle 再查 user_st_settings）
  const [
    userResult,
    charactersResult,
    presetsResult,
    platformSettingsResult,
    apiConfigResult,
    fallbackConfigResult,
    llmCatalogResult,
    llmModelTiersResult,
  ] = await Promise.all([
    schemaClient('miniapp').from('users').select('st_handle').eq('id', userId).single(),
    schemaClient('miniapp')
      .from('characters')
      .select('*')
      .eq('enabled', true)
      .order('sort_order', { ascending: true }),
    schemaClient('st_platform')
      .from('platform_presets')
      .select('id, display_name, preset_payload, is_default')
      .eq('enabled', true)
      .order('sort_order', { ascending: true }),
    schemaClient('st_platform')
      .from('platform_settings')
      .select('platform_version, settings_jsonb, writable_paths')
      .order('platform_version', { ascending: false })
      .limit(1)
      .single(),
    // 分区 A：平台 API 配置（is_default=true 唯一激活行，写 secrets.json 用）
    schemaClient('st_platform')
      .from('platform_api_configs')
      .select('id, config_payload, is_default')
      .eq('is_default', true)
      .limit(1)
      .maybeSingle(),
    // 系统兜底卡 ID（character_ref 失效时的回退值）
    schemaClient('miniapp')
      .from('runtime_config')
      .select('value')
      .eq('key', 'system_fallback_character_id')
      .maybeSingle(),
    // 默认模型配置
    schemaClient('miniapp')
      .from('runtime_config')
      .select('value')
      .eq('key', 'llm_model_catalog')
      .maybeSingle(),
    // 旧配置仅用于尚未发布正式目录的环境。
    schemaClient('miniapp')
      .from('runtime_config')
      .select('value')
      .eq('key', 'llm_model_tiers')
      .maybeSingle(),
  ]);

  // 校验 users
  if (userResult.error || !userResult.data?.st_handle) {
    throw new FetchError(
      `找不到用户 ${userId} 或 st_handle 未初始化（users.st_handle 为 null）`,
      userResult.error
    );
  }
  const stHandle = userResult.data.st_handle as string;

  // 校验 characters
  if (charactersResult.error) {
    throw new FetchError('拉取平台角色卡失败', charactersResult.error);
  }

  // 预设缺失不阻断主链路：角色卡、settings、secrets 仍可完成下发并支持对话。
  const presets = presetsResult.error ? [] : ((presetsResult.data ?? []) as PresetRow[]);

  const platformSettings =
    platformSettingsResult.error || !platformSettingsResult.data
      ? loadLocalPlatformSettings(stHandle)
      : (platformSettingsResult.data as PlatformSettingsRow);

  // 校验 api_config（允许为空：未配置则跳过 secrets.json 写入，不中断 provision）
  const apiConfig =
    apiConfigResult.error || !apiConfigResult.data
      ? createLocalApiConfig()
      : (apiConfigResult.data as ApiConfigRow);

  // 拉取该用户的最新 B 类 settings（允许为空）
  const userSettingsResult = await schemaClient('st_users')
    .from('user_st_settings')
    .select('user_revision, settings_jsonb, based_on_platform_version')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const userSettings = userSettingsResult.error
    ? null
    : ((userSettingsResult.data as UserSettingsRow | null) ?? null);

  // 拉取用户 persona（TG 名字/头像），来自 miniapp.miniapp_user_settings。
  // 允许为空：无行 / 查询失败时 persona.name=null，merger 会保留平台默认 persona。
  const personaResult = await schemaClient('miniapp')
    .from('miniapp_user_settings')
    .select(
      'display_name, tg_first_name, tg_last_name, tg_username, tg_avatar_url, custom_avatar_url, selected_model_id'
    )
    .eq('user_id', userId)
    .maybeSingle();
  const personaSource = personaResult.error
    ? null
    : (personaResult.data as PersonaSourceRow | null);
  const userPersona = resolveUserPersona(personaSource);

  // 解析兜底卡 ID：runtime_config.value 是 JSONB，存储格式为 JSON 字符串 '"uuid"'
  let systemFallbackCharacterId: string | null = null;
  if (!fallbackConfigResult.error && fallbackConfigResult.data) {
    const raw = (fallbackConfigResult.data as { value: unknown }).value;
    systemFallbackCharacterId = typeof raw === 'string' ? raw : null;
  }

  const modelResolution = resolveProvisionModel({
    catalog:
      !llmCatalogResult.error && llmCatalogResult.data
        ? (llmCatalogResult.data as { value: unknown }).value
        : null,
    selectedModelId: personaSource?.selected_model_id,
    legacyTiers:
      !llmModelTiersResult.error && llmModelTiersResult.data
        ? (llmModelTiersResult.data as { value: unknown }).value
        : null,
  });
  if (modelResolution.strictCatalogInvalid) {
    console.warn(
      '[provision-fetcher] Strict model catalog validation failed; runtime-compatible fallback was used'
    );
  }
  const defaultLlmModel = modelResolution.openrouterModelId;

  return {
    stHandle,
    characters: (charactersResult.data ?? []) as CharacterRow[],
    presets,
    platformSettings,
    apiConfig,
    userSettings,
    systemFallbackCharacterId,
    userPersona,
    defaultLlmModel,
  };
}

// ─── persona 解析 ─────────────────────────────────────────────────────────────

interface PersonaSourceRow {
  display_name: string | null;
  tg_first_name: string | null;
  tg_last_name: string | null;
  tg_username: string | null;
  tg_avatar_url: string | null;
  custom_avatar_url: string | null;
  selected_model_id: string | null;
}

/**
 * 从 miniapp_user_settings 行解析出 ST persona。
 * 名字优先级：用户自定义 display_name > TG first(+last) > TG username。
 * 全空则使用默认名，避免 ST 对话页显示运营侧默认 persona。
 */
function resolveUserPersona(row: PersonaSourceRow | null): UserPersona {
  if (!row) return { name: DEFAULT_USER_PERSONA_NAME, avatarUrl: null };

  const display = row.display_name?.trim();
  const fullName = [row.tg_first_name, row.tg_last_name]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join(' ')
    .trim();
  const username = row.tg_username?.trim();

  const name = display || fullName || username || DEFAULT_USER_PERSONA_NAME;
  const avatarUrl = row.custom_avatar_url?.trim() || row.tg_avatar_url?.trim() || null;

  return { name, avatarUrl };
}

function loadLocalPlatformSettings(stHandle: string): PlatformSettingsRow {
  const settings =
    readSettingsJson(join(config.ST_DATA_PATH, stHandle, 'settings.json')) ??
    readSettingsJson(join(config.ST_DATA_PATH, 'default-user', 'settings.json')) ??
    createMinimalSettings();

  return {
    platform_version: 0,
    settings_jsonb: settings,
    writable_paths: [],
  };
}

function readSettingsJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function createMinimalSettings(): Record<string, unknown> {
  return {
    chat_completion_source: 'custom',
    oai_settings: {
      chat_completion_source: 'custom',
      custom_url: 'http://localhost:3001/api/platform/llm-proxy/v1',
      custom_model: 'anthropic/claude-sonnet-4.5',
      bypass_status_check: false,
    },
  };
}

function createLocalApiConfig(): ApiConfigRow {
  return {
    id: 'local-platform-token',
    is_default: true,
    config_payload: {
      provider: 'custom',
      api_key: 'platform-token-placeholder',
    },
  };
}
