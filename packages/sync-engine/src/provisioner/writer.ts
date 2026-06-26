/**
 * sync-engine / provisioner / writer.ts
 *
 * 把内存中的数据写入 ST 文件系统，纯 IO 层。
 * 不包含任何业务逻辑（merge / 校验等由 merger.ts 完成）。
 */

import { copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import {
  charactersDir,
  presetsDir,
  settingsPath,
  secretsPath,
  platformCharacterSrc,
  characterDst,
  presetDst,
  ensureDir,
} from '../lib/st-fs.js';
import type { CharacterRow, PresetRow, ApiConfigRow } from './fetcher.js';
import type { MergedSettings } from './merger.js';
import { config } from '../lib/config.js';

// ─── 写入结果类型 ──────────────────────────────────────────────────────────────
export interface WriteCharactersResult {
  written: string[]; // 实际写入的角色卡 id 列表
  skipped: string[]; // 已存在且跳过的角色卡 id 列表（增量模式）
  missing: string[]; // 平台资产目录中找不到源 PNG 的卡 id 列表
}

export interface WritePresetsResult {
  written: string[];
  skipped: string[];
}

// ─── 写角色卡 PNG ─────────────────────────────────────────────────────────────
/**
 * 从 platform-assets/characters/ 目录复制 PNG 到用户的 characters/ 目录。
 *
 * @param handle  - ST 用户 handle
 * @param characters - 已拉取的平台角色卡列表
 * @param force   - true = 总是覆盖；false = 目标文件已存在则跳过（增量补全）
 */
export function writeCharacters(
  handle: string,
  characters: CharacterRow[],
  force: boolean
): WriteCharactersResult {
  ensureDir(charactersDir(handle));

  const written: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];

  for (const char of characters) {
    const src = platformCharacterSrc(char.id);
    const dst = characterDst(handle, char.id);

    if (!existsSync(src)) {
      // 平台资产目录缺失这张卡的 PNG
      missing.push(char.id);
      continue;
    }

    if (!force && existsSync(dst)) {
      skipped.push(char.id);
      continue;
    }

    copyFileSync(src, dst);
    written.push(char.id);
  }

  return { written, skipped, missing };
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

  const { provider } = apiConfig.config_payload;

  if (!provider) {
    // config_payload 字段不完整，跳过（避免写入无效 secrets）
    return;
  }

  const secretKey = `api_key_${provider}`;
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
