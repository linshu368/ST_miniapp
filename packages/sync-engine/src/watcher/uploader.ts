/**
 * sync-engine / watcher / uploader.ts
 *
 * 反向同步核心管线：
 *   1. 读 settings.json 全文
 *   2. 从 platform_settings 取当前白名单
 *   3. lodash.pick 提取白名单子集
 *   4. canonical JSON → sha256 算 content_hash
 *   5. 与 user_st_settings 最新行 hash 比对（相同跳过）
 *   6. INSERT 新行（append-only）
 *
 * 设计约束：
 *   - character_ref 写入 B 表时不做有效性校验（清单注释已确认，投影阶段才校验）
 *   - append-only：永不 UPDATE，只 INSERT（决策 12）
 *   - content_hash 相同则跳过（决策 6 幂等去重）
 */

import { readFileSync } from 'node:fs';
import { pick } from 'lodash-es';
import { getSupabaseClient } from '../lib/supabase.js';
import { settingsPath } from '../lib/st-fs.js';
import { computeContentHash } from '../lib/hash.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('uploader');

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export interface UploadResult {
  /** true = hash 相同，跳过写入 */
  skipped: boolean;
  /** 写入的 user_revision（跳过时为 null） */
  revision: number | null;
  /** 本次计算的 content_hash */
  contentHash: string;
}

interface WritablePath {
  path: string;
  transform: string;
}

// ─── 主上传函数 ────────────────────────────────────────────────────────────────

/**
 * 执行一次反向同步上传。
 *
 * @param userId  - Supabase 用户 id
 * @param handle  - ST handle（用于定位 settings.json）
 */
export async function uploadSettings(userId: string, handle: string): Promise<UploadResult> {
  const db = getSupabaseClient();
  const log = logger.child({ handle, userId });

  // ── 步骤 1：读 settings.json ──────────────────────────────────────────────
  const filePath = settingsPath(handle);
  let rawSettings: Record<string, unknown>;
  try {
    const content = readFileSync(filePath, 'utf-8');
    rawSettings = JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new UploadError(`读取 settings.json 失败（${filePath}）：${err}`, err);
  }

  // ── 步骤 2：从 platform_settings 取白名单 + platform_version ─────────────
  const { data: platformRow, error: platformErr } = await db
    .schema('st_platform')
    .from('platform_settings')
    .select('platform_version, writable_paths')
    .order('platform_version', { ascending: false })
    .limit(1)
    .single();

  if (platformErr || !platformRow) {
    throw new UploadError(
      `拉取 platform_settings 失败（表可能为空）：${platformErr?.message}`,
      platformErr
    );
  }

  const platformVersion = platformRow.platform_version as number;
  const writablePaths = platformRow.writable_paths as WritablePath[];

  // ── 步骤 3：lodash.pick 提取白名单子集 ───────────────────────────────────
  const whitelistKeys = writablePaths.map((w) => w.path);
  const subset = pick(rawSettings, whitelistKeys) as Record<string, unknown>;

  if (Object.keys(subset).length === 0) {
    log.info('白名单子集为空，跳过');
    return { skipped: true, revision: null, contentHash: '' };
  }

  // ── 步骤 4：canonical hash ────────────────────────────────────────────────
  const contentHash = computeContentHash(subset);

  // ── 步骤 5：查最新行 hash 比对 ────────────────────────────────────────────
  const { data: latestRow, error: latestErr } = await db
    .schema('st_users')
    .from('user_st_settings')
    .select('content_hash')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestErr) {
    throw new UploadError(`查询 user_st_settings 最新行失败：${latestErr.message}`, latestErr);
  }

  if (latestRow && (latestRow as { content_hash: string }).content_hash === contentHash) {
    log.info({ hash: contentHash.slice(0, 12) }, 'hash 未变化，跳过');
    return { skipped: true, revision: null, contentHash };
  }

  // ── 步骤 6：取 max revision + INSERT（append-only） ──────────────────────
  const { data: maxRevRow } = await db
    .schema('st_users')
    .from('user_st_settings')
    .select('user_revision')
    .eq('user_id', userId)
    .order('user_revision', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextRevision = maxRevRow ? (maxRevRow as { user_revision: number }).user_revision + 1 : 1;

  const { error: insertErr } = await db.schema('st_users').from('user_st_settings').insert({
    user_id: userId,
    user_revision: nextRevision,
    settings_jsonb: subset,
    based_on_platform_version: platformVersion,
    content_hash: contentHash,
    source: 'st_watch',
  });

  if (insertErr) {
    // UNIQUE 冲突（同 hash 并发写入）视为幂等成功
    if (insertErr.code === '23505') {
      log.info('hash 冲突（并发去重），跳过');
      return { skipped: true, revision: null, contentHash };
    }
    throw new UploadError(`INSERT user_st_settings 失败：${insertErr.message}`, insertErr);
  }

  log.info(
    {
      revision: nextRevision,
      platformVersion,
      hash: contentHash.slice(0, 12),
    },
    '写入成功'
  );

  return { skipped: false, revision: nextRevision, contentHash };
}

// ─── 错误类型 ─────────────────────────────────────────────────────────────────

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'UploadError';
  }
}
