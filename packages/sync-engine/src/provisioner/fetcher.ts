/**
 * sync-engine / provisioner / fetcher.ts
 *
 * 从 Supabase 拉取 provisioner 所需的全部数据。
 * 职责：纯数据拉取，不做任何转换逻辑。
 */

import { getSupabaseClient, schemaClient } from '../lib/supabase.js';

// ─── 数据类型定义 ──────────────────────────────────────────────────────────────

export interface CharacterRow {
  id: string;
  name: string;
  is_default: boolean;
  enabled: boolean;
  sort_order: number;
  // chara_card_v3 字段（provisioner 不需要全部，按需取）
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

export interface ProvisionData {
  /** 用户 st_handle，从 users 表读取 */
  stHandle: string;
  /** 分区 A：enabled 的平台角色卡列表（按 sort_order 排序） */
  characters: CharacterRow[];
  /** 分区 A：enabled 的平台预设列表 */
  presets: PresetRow[];
  /** 分区 A：最新版本的平台 settings */
  platformSettings: PlatformSettingsRow;
  /** 分区 A：is_default=true 的平台 API 配置（用于写 secrets.json） */
  apiConfig: ApiConfigRow | null;
  /** 分区 B：该用户最新的 settings 镜像（可能为 null，表示新用户）  */
  userSettings: UserSettingsRow | null;
}

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
  const [userResult, charactersResult, presetsResult, platformSettingsResult, apiConfigResult] =
    await Promise.all([
      db.from('users').select('st_handle').eq('id', userId).single(),
      // ⚠️ .schema() 必须在链首（Supabase JS v2 要求）
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

  // 校验 presets
  if (presetsResult.error) {
    throw new FetchError('拉取平台预设失败', presetsResult.error);
  }

  // 校验 platform_settings
  if (platformSettingsResult.error || !platformSettingsResult.data) {
    throw new FetchError(
      '拉取平台 settings 失败（platform_settings 表可能为空，请先执行种子数据迁移）',
      platformSettingsResult.error
    );
  }

  // 校验 api_config（允许为空：未配置则跳过 secrets.json 写入，不中断 provision）
  if (apiConfigResult.error) {
    throw new FetchError('拉取平台 API 配置失败', apiConfigResult.error);
  }

  // 拉取该用户的最新 B 类 settings（允许为空）
  const userSettingsResult = await schemaClient('st_users')
    .from('user_st_settings')
    .select('user_revision, settings_jsonb, based_on_platform_version')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (userSettingsResult.error) {
    throw new FetchError('拉取用户 settings 镜像失败', userSettingsResult.error);
  }

  return {
    stHandle,
    characters: (charactersResult.data ?? []) as CharacterRow[],
    presets: (presetsResult.data ?? []) as PresetRow[],
    platformSettings: platformSettingsResult.data as PlatformSettingsRow,
    apiConfig: (apiConfigResult.data as ApiConfigRow | null) ?? null,
    userSettings: (userSettingsResult.data as UserSettingsRow | null) ?? null,
  };
}
