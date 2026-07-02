/**
 * sync-engine / provisioner / index.ts
 *
 * 主函数 provision(userId, options)。
 * 可被 Bridge 直接 import 调用，也可通过 run.ts 作为 CLI 使用。
 *
 * 执行顺序（严格遵循清单 order 约束，决策 5）：
 *   1. 拉取数据（Supabase）
 *   2. 确保 ST 用户账号存在（ST API）
 *   3. order=10  写角色卡 PNG（资产层）
 *   4. order=20  写预设 JSON（资产层）
 *   5. order=100 merge + 写 settings.json（配置层）
 *   6. 更新 users.st_initialized_at
 */

import { getSupabaseClient } from '../lib/supabase.js';
import { config } from '../lib/config.js';
import { listCharacterIds } from '../lib/st-fs.js';
import { fetchProvisionData } from './fetcher.js';
import { mergeSettings } from './merger.js';
import {
  writeCharacters,
  writeCharacterById,
  writePresets,
  writeSettings,
  writeSecrets,
} from './writer.js';
import type { WriteCharactersResult } from './writer.js';
import { ensureStUser } from './st-user.js';

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/**
 * 角色卡下发范围（懒下发策略）：
 *   'all'（默认）  = 下发全部上架角色卡（CLI / 全量重投影语义，保持不变）
 *   'none'         = 关键路径不下发任何角色卡（登录只做配置下发；卡走进对话页时按需拉）
 *   { ids: [...] } = 只下发指定 id 的卡（子集下发）
 */
export type CharacterScope = 'all' | 'none' | { ids: string[] };

export interface ProvisionOptions {
  /**
   * false（默认）= 增量补全：已存在的文件跳过
   * true         = 全量覆盖：强制重写所有文件
   */
  force?: boolean;
  /**
   * 角色卡下发范围，默认 'all'（保持 CLI / 历史行为）。
   * 登录关键路径传 'none' 以消除全量卡下载尖峰。
   */
  characterScope?: CharacterScope;
  /** 日志回调，默认输出到 console.log */
  log?: (msg: string) => void;
}

export interface ProvisionResult {
  userId: string;
  stHandle: string;
  charactersWritten: number;
  charactersSkipped: number;
  charactersMissing: number;
  presetsWritten: number;
  presetsSkipped: number;
  hadInvalidRef: boolean;
  invalidRefValue?: string;
  alreadyInitialized: boolean;
}

// ─── 自定义错误 ────────────────────────────────────────────────────────────────
export class ProvisionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

// ─── 主函数 ────────────────────────────────────────────────────────────────────
export async function provision(
  userId: string,
  options: ProvisionOptions = {}
): Promise<ProvisionResult> {
  const { force = false, characterScope = 'all', log = console.log } = options;

  const scopeLabel =
    characterScope === 'all'
      ? 'all'
      : characterScope === 'none'
        ? 'none'
        : `ids[${characterScope.ids.length}]`;
  log(`[provision] 开始 → userId=${userId}, force=${force}, characterScope=${scopeLabel}`);

  // ── 1. 拉取 Supabase 数据 ──────────────────────────────────────────────────
  log('[provision] 步骤 1/5：从 Supabase 拉取数据...');
  let data;
  try {
    data = await fetchProvisionData(userId);
  } catch (err) {
    throw new ProvisionError(`拉取数据失败：${err}`, err);
  }
  const {
    stHandle,
    characters,
    presets,
    platformSettings,
    apiConfig,
    userSettings,
    systemFallbackCharacterId,
  } = data;

  log(
    `[provision]   handle=${stHandle}, 角色卡=${characters.length} 张, 预设=${presets.length} 条`
  );
  log(
    `[provision]   platform_version=${platformSettings.platform_version}, B类记录=${userSettings ? `revision=${userSettings.user_revision}` : '无（新用户）'}`
  );

  // ── 2. 确保 ST 用户账号存在 ────────────────────────────────────────────────
  log('[provision] 步骤 2/5：确保 ST 用户账号存在...');
  let stUserResult;
  try {
    stUserResult = await ensureStUser({
      handle: stHandle,
      displayName: stHandle, // 阶段一用 handle 作为显示名
    });
  } catch (err) {
    throw new ProvisionError(`创建 ST 用户失败：${err}`, err);
  }
  log(`[provision]   ST 用户：${stUserResult.created ? '新建' : '已存在跳过'}`);

  // 检查是否已初始化（仅在非 force 模式下作为提示，不跳过后续步骤）
  // B 类有记录 = 曾经初始化过；force 模式下仍执行全量覆盖
  const alreadyInitialized = userSettings !== null;

  // ── 3. order=10：写角色卡 PNG（资产层，受 characterScope 控制）───────────────
  log('[provision] 步骤 3/5：下发角色卡 PNG（order=10）...');
  let charResult: WriteCharactersResult;
  try {
    if (characterScope === 'none') {
      // 关键路径：不下发任何角色卡（登录只做配置下发，消除全量下载尖峰）
      charResult = { written: [], skipped: [], missing: [] };
      log('[provision]   characterScope=none，跳过角色卡批量下发（走进对话页时按需拉取）');
    } else {
      const onlyIds = typeof characterScope === 'object' ? characterScope.ids : undefined;
      charResult = await writeCharacters(stHandle, characters, force, onlyIds);
    }
  } catch (err) {
    throw new ProvisionError(`写入角色卡失败：${err}`, err);
  }
  log(
    `[provision]   写入=${charResult.written.length}, 跳过=${charResult.skipped.length}, 缺失=${charResult.missing.length}`
  );
  if (charResult.missing.length > 0) {
    log(`[provision]   ⚠️  缺失的角色卡 id：${charResult.missing.join(', ')}`);
    log(
      `[provision]      请确认 Storage bucket「${config.CHARACTER_STORAGE_BUCKET}」中包含对应的 PNG 文件`
    );
  }

  // ── 4. order=20：写预设 JSON（资产层）─────────────────────────────────────
  log('[provision] 步骤 4/5：下发预设文件（order=20）...');
  let presetResult;
  try {
    presetResult = writePresets(stHandle, presets, force);
  } catch (err) {
    throw new ProvisionError(`写入预设失败：${err}`, err);
  }
  log(`[provision]   写入=${presetResult.written.length}, 跳过=${presetResult.skipped.length}`);

  // ── 4.5 order=30：写 secrets.json（API Key，资产层）────────────────────────
  log('[provision] 步骤 4.5/5：写入 secrets.json（order=30）...');
  try {
    writeSecrets(stHandle, apiConfig, userId);
    if (apiConfig) {
      log(`[provision]   secrets.json 写入完成（provider=${apiConfig.config_payload.provider}）`);
    } else {
      log('[provision]   ⚠️  platform_api_configs 无 is_default=true 行，跳过 secrets.json 写入');
    }
  } catch (err) {
    throw new ProvisionError(`写入 secrets.json 失败：${err}`, err);
  }

  // ── 5. order=100：merge settings + 写 settings.json（配置层）─────────────
  log('[provision] 步骤 5/5：合并 settings.json（order=100）...');

  // 可用角色卡 id 列表（用于 character_ref 有效性校验）。
  //   scope='all'：本次 written+skipped 即等于磁盘全量，直接用（省一次 readdir）。
  //   scope='none'/子集：本次可能一张都没写，必须以「磁盘真实存在」为准，否则
  //                      character_ref 会被误判失效而回退。
  const availableCharIds =
    characterScope === 'all'
      ? [...charResult.written, ...charResult.skipped]
      : listCharacterIds(stHandle);

  let merged;
  try {
    merged = mergeSettings(
      platformSettings,
      userSettings,
      availableCharIds,
      systemFallbackCharacterId ?? undefined,
      config.LLM_PROXY_URL
    );
  } catch (err) {
    throw new ProvisionError(`merge settings 失败：${err}`, err);
  }

  if (merged.hadInvalidRef) {
    log(
      `[provision]   ⚠️  character_ref 失效（原值='${merged.invalidRefValue}'），已回退到系统兜底卡`
    );
  }

  try {
    writeSettings(stHandle, merged);
  } catch (err) {
    throw new ProvisionError(`写入 settings.json 失败：${err}`, err);
  }
  log('[provision]   settings.json 写入完成');

  // ── 6. 更新 users.st_initialized_at ───────────────────────────────────────
  const { error: updateError } = await getSupabaseClient()
    .from('users')
    .update({ st_initialized_at: new Date().toISOString() })
    .eq('id', userId);

  if (updateError) {
    // 非致命错误：主流程已完成，仅记录警告
    log(`[provision]   ⚠️  更新 st_initialized_at 失败：${updateError.message}`);
  }

  const result: ProvisionResult = {
    userId,
    stHandle,
    charactersWritten: charResult.written.length,
    charactersSkipped: charResult.skipped.length,
    charactersMissing: charResult.missing.length,
    presetsWritten: presetResult.written.length,
    presetsSkipped: presetResult.skipped.length,
    hadInvalidRef: merged.hadInvalidRef,
    invalidRefValue: merged.invalidRefValue,
    alreadyInitialized,
  };

  log(`[provision] ✅ 完成 → handle=${stHandle}`);
  return result;
}

// ─── 单卡按需下发（懒下发关键路径）──────────────────────────────────────────────

export interface EnsureCharacterResult {
  stHandle: string;
  /** 'written' 新下发 | 'skipped' 已缓存 | 'missing' storage 无此卡 */
  status: 'written' | 'skipped' | 'missing';
}

/**
 * 只确保「当前打开的这一张」角色卡落盘，供前端进入 /tavern/<id> 时按需调用。
 *
 * 与 provision() 相比刻意做得极轻：只解析 handle + 下载/跳过单张 PNG，
 * 不重跑 settings/secrets/presets merge，把关键路径延迟压到最低。
 * 幂等：已存在则 skip。
 */
export async function ensureCharacterProvisioned(
  userId: string,
  characterId: string,
  options: { log?: (msg: string) => void } = {}
): Promise<EnsureCharacterResult> {
  const { log = console.log } = options;

  const { data, error } = await getSupabaseClient()
    .from('users')
    .select('st_handle')
    .eq('id', userId)
    .single();

  const stHandle = (data as { st_handle: string | null } | null)?.st_handle;
  if (error || !stHandle) {
    throw new ProvisionError(
      `找不到用户 ${userId} 或 st_handle 未初始化（需先完成 st-session 登录）`,
      error
    );
  }

  const status = await writeCharacterById(stHandle, characterId, false);
  log(`[ensure-character] handle=${stHandle}, id=${characterId} → ${status}`);

  return { stHandle, status };
}
