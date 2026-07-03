/**
 * sync-engine / provisioner / writer.ts
 *
 * 把内存中的数据写入 ST 文件系统，纯 IO 层。
 * 不包含任何业务逻辑（merge / 校验等由 merger.ts 完成）。
 */

import { writeFileSync, existsSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import {
  charactersDir,
  presetsDir,
  settingsPath,
  secretsPath,
  characterDst,
  characterStoragePath,
  presetDst,
  ensureDir,
  userAvatarsDir,
  userAvatarDst,
} from '../lib/st-fs.js';
import { getSupabaseClient } from '../lib/supabase.js';
import type { CharacterRow, PresetRow, ApiConfigRow } from './fetcher.js';
import type { MergedSettings } from './merger.js';
import { config } from '../lib/config.js';

export const DEFAULT_USER_AVATAR_FILENAME = '4d015fdd-7f82-482c-912d-466eaa826280.png';

// ─── 写入结果类型 ──────────────────────────────────────────────────────────────
export interface WriteCharactersResult {
  written: string[];
  skipped: string[];
  missing: string[];
}

export interface WritePresetsResult {
  written: string[];
  skipped: string[];
}

// ─── 写角色卡 PNG ─────────────────────────────────────────────────────────────
/**
 * 从 Supabase Storage 下载角色卡 PNG 到用户的 characters/ 目录。
 *
 * @param handle     - ST 用户 handle
 * @param characters - 已拉取的平台角色卡列表
 * @param force      - true = 总是覆盖；false = 目标文件已存在则跳过（懒下发）
 * @param onlyIds    - 可选：只下发这些 id 的卡（子集下发，用于按需/懒下发）；
 *                     不传 = 下发全部（保持原有全量语义）
 */
export async function writeCharacters(
  handle: string,
  characters: CharacterRow[],
  force: boolean,
  onlyIds?: string[]
): Promise<WriteCharactersResult> {
  ensureDir(charactersDir(handle));

  const written: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];

  const targets = onlyIds ? characters.filter((c) => onlyIds.includes(c.id)) : characters;

  for (const char of targets) {
    const dst = characterDst(handle, char.id);

    if (!force && existsSync(dst)) {
      skipped.push(char.id);
      continue;
    }

    const storagePath = characterStoragePath(char.id);
    const { data, error } = await getSupabaseClient()
      .storage.from(config.CHARACTER_STORAGE_BUCKET)
      .download(storagePath);

    if (error || !data) {
      missing.push(char.id);
      continue;
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    writeFileSync(dst, buffer);
    written.push(char.id);
  }

  return { written, skipped, missing };
}

// ─── 按 id 下发单张角色卡（懒下发关键路径）──────────────────────────────────────
/**
 * 只确保「一张」平台角色卡 PNG 落盘，供进入对话页时按需下发。
 * 不依赖 CharacterRow（storage 路径与目标文件名都只由 characterId 决定），
 * 因此无需先拉全量 characters 列表，关键路径尽量轻。
 *
 * @param handle      - ST 用户 handle
 * @param characterId - 平台角色卡 id（UUID）
 * @param force       - true = 总是覆盖；false = 已存在则跳过
 * @returns 'written' | 'skipped' | 'missing'（storage 无此卡）
 */
export async function writeCharacterById(
  handle: string,
  characterId: string,
  force: boolean
): Promise<'written' | 'skipped' | 'missing'> {
  ensureDir(charactersDir(handle));

  const dst = characterDst(handle, characterId);
  if (!force && existsSync(dst)) {
    return 'skipped';
  }

  const { data, error } = await getSupabaseClient()
    .storage.from(config.CHARACTER_STORAGE_BUCKET)
    .download(characterStoragePath(characterId));

  if (error || !data) {
    return 'missing';
  }

  writeFileSync(dst, Buffer.from(await data.arrayBuffer()));
  return 'written';
}

// ─── 写用户 persona 头像 ───────────────────────────────────────────────────────
/**
 * 确保用户的 TG 头像落到 data/<handle>/User Avatars/<handle>.png，供 ST persona 使用。
 *
 * 文件名用 `<handle>.png`（每用户稳定唯一）。返回可用于 settings.user_avatar 的文件名，
 * 无头像源时下载平台默认头像。下载失败不抛错——persona 名字仍能注入，头像回退默认。
 *
 * @param handle    - ST 用户 handle
 * @param avatarUrl - TG photo_url / 用户自定义头像 URL（可为空）
 * @param force     - true = 总是重新下载覆盖；false = 本地已存在则复用
 */
export async function ensureUserAvatar(
  handle: string,
  avatarUrl: string | null,
  force: boolean
): Promise<string | null> {
  const filename = `${handle}.png`;
  const dst = userAvatarDst(handle, filename);

  if (avatarUrl) {
    if (!force && existsSync(dst)) return filename;

    try {
      const res = await fetch(avatarUrl);
      if (res.ok) {
        ensureDir(userAvatarsDir(handle));
        writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
        return filename;
      }
    } catch {
      // 网络失败不阻断 provision：有旧文件则复用，否则回退默认头像
    }

    if (existsSync(dst)) return filename;
  }

  return await ensureDefaultUserAvatar(handle);
}

async function ensureDefaultUserAvatar(handle: string): Promise<string | null> {
  const dst = userAvatarDst(handle, DEFAULT_USER_AVATAR_FILENAME);
  if (existsSync(dst)) return DEFAULT_USER_AVATAR_FILENAME;

  try {
    const res = await fetch(config.DEFAULT_USER_AVATAR_URL);
    if (!res.ok) return null;
    ensureDir(userAvatarsDir(handle));
    writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
    return DEFAULT_USER_AVATAR_FILENAME;
  } catch {
    return null;
  }
}

// ─── 写预设 JSON ───────────────────────────────────────────────────────────────
/**
 * 将平台预设 payload 序列化为 JSON，写入用户的 OpenAI Settings/ 目录。
 *
 * @param handle  - ST 用户 handle
 * @param presets - 已拉取的平台预设列表
 * @param force   - true = 总是覆盖；false = 目标文件已存在则跳过
 */
export function writePresets(
  handle: string,
  presets: PresetRow[],
  force: boolean
): WritePresetsResult {
  ensureDir(presetsDir(handle));

  const written: string[] = [];
  const skipped: string[] = [];

  for (const preset of presets) {
    const dst = presetDst(handle, preset.id);

    if (!force && existsSync(dst)) {
      skipped.push(preset.id);
      continue;
    }

    writeFileSync(dst, JSON.stringify(preset.preset_payload, null, 2), 'utf-8');
    written.push(preset.id);
  }

  return { written, skipped };
}

// ─── 写 settings.json ─────────────────────────────────────────────────────────
/**
 * 将 merge 后的 settings 对象写入 data/<handle>/settings.json。
 * settings.json 总是覆盖写（merge 结果本身已经融合了用户偏好）。
 */
export function writeSettings(handle: string, mergedSettings: MergedSettings): void {
  const dst = settingsPath(handle);
  writeFileSync(dst, JSON.stringify(mergedSettings.settings, null, 2), 'utf-8');
}

// ─── 写 secrets.json ──────────────────────────────────────────────────────────
/**
 * 将平台 API 配置写入 data/<handle>/secrets.json。
 *
 * 分区 A 语义：Supabase = 绝对真相，永远覆盖写，不做 skip-if-exists。
 *
 * ST secrets.json 格式（从 default-user/secrets.json 确认）：
 *   {
 *     "api_key_<provider>": [
 *       { "id": "<uuid>", "value": "<api_key>", "label": "<date>", "active": true }
 *     ]
 *   }
 *
 * config_payload.provider 决定 key 名，如 "openrouter" → "api_key_openrouter"。
 */
export function writeSecrets(handle: string, apiConfig: ApiConfigRow | null, userId: string): void {
  if (!apiConfig) {
    // 未配置 API Key，跳过写入（不报错，provisioner 日志会标注）
    return;
  }

  // 平台在 merger.ts 恒定强制 oai_settings.chat_completion_source='custom'，而 ST 的 custom 源
  // 固定读取密钥槽 api_key_custom（见 vendor scripts/secrets.js SECRET_KEYS.CUSTOM 与
  // endpoints/backends/chat-completions.js 的 CUSTOM 分支）。因此 per-user JWT 必须写入
  // api_key_custom，与 config_payload.provider（可能为 openrouter 等）无关；否则 custom 源取不到
  // key，ST 发起请求时 Authorization 为空 → llm-proxy 返回 401「Missing or invalid Authorization header」。
  const secretKey = 'api_key_custom';
  const platformToken = signPlatformToken(userId);
  const secrets = {
    [secretKey]: [
      {
        id: randomUUID(),
        value: platformToken,
        label: new Date().toLocaleString('en-US', {
          month: '2-digit',
          day: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        }),
        active: true,
      },
    ],
  };

  const dst = secretsPath(handle);
  writeFileSync(dst, JSON.stringify(secrets, null, 2), 'utf-8');
}

function signPlatformToken(userId: string): string {
  const secret = config.LLM_PROXY_TOKEN_SECRET || config.ST_USER_PASSWORD_SECRET;
  if (!secret) {
    throw new Error('LLM_PROXY_TOKEN_SECRET 未配置，无法签发 platformToken');
  }

  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({ userId, iat: Math.floor(Date.now() / 1000), ver: 1 })
  );
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');

  return `${header}.${payload}.${signature}`;
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data, 'utf-8').toString('base64url');
}
