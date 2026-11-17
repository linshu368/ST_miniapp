import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError } from './errors';

/**
 * 本机状态只有两份文件：config.json（生产后端地址 + 公开 anon key）和 session.json（登录会话）。
 * 目录 0700、文件 0600，写入走“临时文件 + rename”，进程中途被杀也不会留下半截文件。
 */

export interface CliConfig {
  apiUrl: string;
  anonKey: string;
}

export interface SessionMeta {
  email: string;
  operatorName: string;
  loggedInAt: string;
}

interface SessionFile {
  items: Record<string, string>;
  meta?: SessionMeta;
}

export function adminHome(): string {
  return process.env.MIJING_ADMIN_HOME || join(homedir(), '.config', 'mijing-admin');
}

const configPath = () => join(adminHome(), 'config.json');
const sessionPath = () => join(adminHome(), 'session.json');
const lockPath = () => join(adminHome(), 'session.lock');

function ensureHome(): void {
  mkdirSync(adminHome(), { recursive: true, mode: 0o700 });
  chmodSync(adminHome(), 0o700);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CliError('unknown', `本机文件 ${path} 无法解析，可删除后重新 setup/login`);
  }
}

function writeJsonSecure(path: string, data: unknown): void {
  ensureHome();
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function normalizeApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CliError('usage', `后端地址不是合法 URL：${raw}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new CliError('usage', '后端地址必须是 https（本机调试可用 http://localhost）');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new CliError('usage', '后端地址不能包含查询参数、锚点或账号信息');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** 环境变量优先，便于临时指向别的后端；否则读 setup 写下的文件。 */
export function loadConfig(): CliConfig {
  const envUrl = process.env.MIJING_ADMIN_API_URL;
  const envKey = process.env.MIJING_ADMIN_ANON_KEY;
  const file = readJson<Partial<CliConfig>>(configPath());
  const apiUrl = envUrl || file?.apiUrl;
  const anonKey = envKey || file?.anonKey;
  if (!apiUrl || !anonKey) {
    throw new CliError(
      'setup_required',
      '尚未配置生产后端地址与 anon key。请本人执行：pnpm admin setup（或设置 MIJING_ADMIN_API_URL / MIJING_ADMIN_ANON_KEY）'
    );
  }
  return { apiUrl: normalizeApiUrl(apiUrl), anonKey };
}

export function saveConfig(config: CliConfig): void {
  writeJsonSecure(configPath(), config);
}

function readSessionFile(): SessionFile {
  return readJson<SessionFile>(sessionPath()) ?? { items: {} };
}

/** supabase-js 的 storage 接口，会话 token 只存在这个文件里。 */
export class FileSessionStorage {
  getItem(key: string): string | null {
    return readSessionFile().items[key] ?? null;
  }

  setItem(key: string, value: string): void {
    const file = readSessionFile();
    file.items[key] = value;
    writeJsonSecure(sessionPath(), file);
  }

  removeItem(key: string): void {
    const file = readSessionFile();
    delete file.items[key];
    writeJsonSecure(sessionPath(), file);
  }
}

export function readSessionMeta(): SessionMeta | null {
  return readSessionFile().meta ?? null;
}

export function writeSessionMeta(meta: SessionMeta): void {
  const file = readSessionFile();
  writeJsonSecure(sessionPath(), { ...file, meta });
}

export function clearSession(): void {
  rmSync(sessionPath(), { force: true });
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

/**
 * 多个 CLI 进程（例如 AI 并行调用）同时刷新 token 时，Supabase 的 refresh token 轮换会让后到的一方失效。
 * 用目录锁串行化“读会话→必要时刷新→写回”，拿到锁后再读文件，就能用上别的进程刚刷新好的会话。
 */
export async function withSessionLock<T>(work: () => Promise<T>): Promise<T> {
  ensureHome();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockPath(), { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath()).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath(), { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new CliError(
          'unavailable',
          '等待会话锁超时：另一个 mijing-admin 进程正在刷新登录状态，请稍后重试'
        );
      }
      await sleep(100);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lockPath(), { recursive: true, force: true });
  }
}
