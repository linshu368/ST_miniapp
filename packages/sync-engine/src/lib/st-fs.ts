/**
 * sync-engine / lib / st-fs.ts
 *
 * ST 文件系统路径工具。
 * 按 handle 定位 data/<handle>/ 下的各子目录和文件。
 * 所有路径计算集中在此，其他模块不直接拼路径。
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { config } from './config.js';

/** 返回某用户的工作目录根：ST_DATA_PATH/<handle>/ */
export function handleDir(handle: string): string {
  return join(config.ST_DATA_PATH, handle);
}

/** data/<handle>/characters/ */
export function charactersDir(handle: string): string {
  return join(handleDir(handle), 'characters');
}

/** data/<handle>/OpenAI Settings/ */
export function presetsDir(handle: string): string {
  return join(handleDir(handle), 'OpenAI Settings');
}

/** data/<handle>/settings.json */
export function settingsPath(handle: string): string {
  return join(handleDir(handle), 'settings.json');
}

/** data/<handle>/secrets.json */
export function secretsPath(handle: string): string {
  return join(handleDir(handle), 'secrets.json');
}

/**
 * Supabase Storage 中角色卡 PNG 的对象路径。
 * 完整 URL = SUPABASE_URL/storage/v1/object/public/<bucket>/<path>
 */
export function characterStoragePath(characterId: string): string {
  return `characters/platform_${characterId}.png`;
}

/** data/<handle>/characters/platform_<id>.png */
export function characterDst(handle: string, characterId: string): string {
  return join(charactersDir(handle), `platform_${characterId}.png`);
}

/** data/<handle>/OpenAI Settings/platform_<id>.json */
export function presetDst(handle: string, presetId: string): string {
  return join(presetsDir(handle), `platform_${presetId}.json`);
}

/**
 * 确保目录存在（recursive mkdir）。
 * 幂等，目录已存在时不报错。
 */
export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 扫描 ST_DATA_PATH 下所有 tg-<digits> 或历史 tg_<digits> 格式的用户目录，返回 handle 列表。
 * 用于 watcher 启动时确定需要监听的用户范围。
 */
export function listHandles(): string[] {
  const dataPath = config.ST_DATA_PATH;
  if (!existsSync(dataPath)) return [];

  return readdirSync(dataPath).filter((name) => {
    // 新用户使用 tg-；历史目录可能仍是 tg_，watcher 需要继续扫描。
    if (!/^tg[-_]\d+$/.test(name)) return false;
    return statSync(join(dataPath, name)).isDirectory();
  });
}
