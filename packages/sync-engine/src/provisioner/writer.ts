/**
 * sync-engine / provisioner / writer.ts
 *
 * 把内存中的数据写入 ST 文件系统，纯 IO 层。
 * 不包含任何业务逻辑（merge / 校验等由 merger.ts 完成）。
 */

import { copyFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backgroundDst,
  backgroundsDir,
  charactersDir,
  presetsDir,
  settingsPath,
  secretsPath,
  characterDst,
  characterStoragePath,
  presetDst,
  ensureDir,
  themeDst,
  themesDir,
  userAvatarsDir,
  userAvatarDst,
} from '../lib/st-fs.js';
import { getSupabaseClient } from '../lib/supabase.js';
import type { CharacterRow, PresetRow, ApiConfigRow } from './fetcher.js';
import type { MergedSettings } from './merger.js';
import { config } from '../lib/config.js';
import { DEFAULT_USER_AVATAR_FILENAME } from './user-avatar-constants.js';

const GLIMMER_THEME_FILENAME = 'Glimmer - by Rivelle.json';
const MOONLIT_BACKGROUND_FILENAME = 'night-city-anime.jpg';

/**
 * 优先使用部署环境显式声明的资产目录。本地开发则从 cwd 与当前模块位置逐级向上
 * 查找仓库中的 ops/st-platform-assets，不依赖源码位于 src/ 还是编译产物位于 dist/。
 */
function resolvePlatformAssetsRoot(): string {
  if (config.PLATFORM_ASSETS_ROOT) {
    return resolve(config.PLATFORM_ASSETS_ROOT);
  }

  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  const checked = new Set<string>();

  for (const start of starts) {
    let current = resolve(start);
    while (true) {
      const candidate = resolve(current, 'ops/st-platform-assets');
      if (!checked.has(candidate)) {
        checked.add(candidate);
        if (existsSync(candidate)) return candidate;
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  throw new Error(
    `平台 ST 资产目录不存在；请设置 PLATFORM_ASSETS_ROOT。已检查：${[...checked].join(', ')}`
  );
}

/**
 * 原子写：先写同目录临时文件，再 rename 到目标路径。
 *
 * rename 在同一文件系统是原子操作，读者要么看到完整旧文件、要么看到完整新文件，
 * 杜绝「部分读」。用于 settings.json / secrets.json 这类**总是覆盖写、且会被 ST
 * 启动时读取**的配置文件——老用户「先放行、provision 后台异步刷新」时，后台写与
 * ST 启动读可能并发，非原子的 writeFileSync 存在读到截断 JSON → 解析失败的竞态。
 */
function atomicWriteFileSync(dst: string, contents: string): void {
  const tmp = `${dst}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, contents, 'utf-8');
  renameSync(tmp, dst);
}

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

export interface WritePlatformAssetsResult {
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
  // URL（平台上传 URL 含版本参数）变化时换文件名，避免 ST/浏览器继续命中旧头像缓存。
  const sourceVersion = avatarUrl
    ? createHash('sha256').update(avatarUrl).digest('hex').slice(0, 12)
    : null;
  const filename = sourceVersion ? `${handle}-${sourceVersion}.png` : `${handle}.png`;
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

  // 默认头像随 st-bundle 一并发布，优先从本地资产复制，避免 provision 依赖
  // Supabase 公网可用性；远程 URL 仅作为旧部署/本地环境的兼容回退。
  try {
    const bundled = resolve(
      resolvePlatformAssetsRoot(),
      'user-avatars',
      DEFAULT_USER_AVATAR_FILENAME
    );
    if (existsSync(bundled)) {
      ensureDir(userAvatarsDir(handle));
      copyFileSync(bundled, dst);
      return DEFAULT_USER_AVATAR_FILENAME;
    }
  } catch {
    // 未配置平台资产目录时继续尝试远程默认头像。
  }

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

// ─── 写平台主题与背景 ─────────────────────────────────────────────────────────
/**
 * 把平台固定的 ST 视觉资产下发到每个独立用户目录。
 *
 * 不能只写 default-user：MiniApp 每个 Telegram 用户都使用 data/<handle>/，
 * 且其 settings.json 由 provision 独立投影。
 */
export function writePlatformAssets(handle: string, force: boolean): WritePlatformAssetsResult {
  const platformAssetsRoot = resolvePlatformAssetsRoot();
  const assets = [
    {
      source: resolve(platformAssetsRoot, 'themes', GLIMMER_THEME_FILENAME),
      destination: themeDst(handle, GLIMMER_THEME_FILENAME),
      directory: themesDir(handle),
      label: `themes/${GLIMMER_THEME_FILENAME}`,
    },
    {
      source: resolve(platformAssetsRoot, 'backgrounds', MOONLIT_BACKGROUND_FILENAME),
      destination: backgroundDst(handle, MOONLIT_BACKGROUND_FILENAME),
      directory: backgroundsDir(handle),
      label: `backgrounds/${MOONLIT_BACKGROUND_FILENAME}`,
    },
  ];
  const written: string[] = [];
  const skipped: string[] = [];

  for (const asset of assets) {
    if (!existsSync(asset.source)) {
      throw new Error(
        `平台 ST 资产不存在：${asset.source}（PLATFORM_ASSETS_ROOT=${platformAssetsRoot}）`
      );
    }
    ensureDir(asset.directory);
    if (!force && existsSync(asset.destination)) {
      skipped.push(asset.label);
      continue;
    }
    copyFileSync(asset.source, asset.destination);
    written.push(asset.label);
  }

  return { written, skipped };
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
  atomicWriteFileSync(dst, JSON.stringify(mergedSettings.settings, null, 2));
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
  atomicWriteFileSync(dst, JSON.stringify(secrets, null, 2));
}

export function writeSimulationSecrets(
  handle: string,
  apiConfig: ApiConfigRow | null,
  conversationId: string
): void {
  if (!apiConfig) return;

  const now = Math.floor(Date.now() / 1000);
  const platformToken = signTokenPayload({
    mode: 'simulation',
    conversationId,
    iat: now,
    exp: now + 24 * 60 * 60,
    ver: 2,
  });
  const secrets = {
    api_key_custom: [
      {
        id: randomUUID(),
        value: platformToken,
        label: 'simulation',
        active: true,
      },
    ],
  };
  atomicWriteFileSync(secretsPath(handle), JSON.stringify(secrets, null, 2));
}

function signPlatformToken(userId: string): string {
  return signTokenPayload({ userId, iat: Math.floor(Date.now() / 1000), ver: 1 });
}

function signTokenPayload(payloadValue: Record<string, unknown>): string {
  const secret = config.LLM_PROXY_TOKEN_SECRET || config.ST_USER_PASSWORD_SECRET;
  if (!secret) {
    throw new Error('LLM_PROXY_TOKEN_SECRET 未配置，无法签发 platformToken');
  }

  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify(payloadValue));
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');

  return `${header}.${payload}.${signature}`;
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data, 'utf-8').toString('base64url');
}
