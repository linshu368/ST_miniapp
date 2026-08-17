/**
 * sync-engine / provisioner / st-user.ts
 *
 * 通过 ST 原生 API 创建用户账号。
 *
 * 设计原则：「凡是 ST 原生有的能力，都通过 ST 的 API 调用，不直接写文件绕过 ST」
 *
 * 密码派生规则：HMAC-SHA256(ST_USER_PASSWORD_SECRET, handle)
 *   - 确定性派生，handle 唯一则密码唯一
 *   - Bridge 登录 ST 时用相同公式还原密码，两端保持一致
 *   - 密钥只存在于服务端环境变量，不落库不传客户端
 */

import { createHmac } from 'node:crypto';
import { config } from '../lib/config.js';

// ─── 密码派生 ─────────────────────────────────────────────────────────────────
/**
 * 为给定 handle 派生唯一的 ST 登录密码。
 * Bridge 侧在登录 ST 时调用相同函数获得同一密码。
 */
export function deriveUserPassword(handle: string): string {
  return createHmac('sha256', config.ST_USER_PASSWORD_SECRET)
    .update(handle)
    .digest('hex')
    .slice(0, 32); // 取前 32 位十六进制，足够安全且简洁
}

// ─── ST API 调用工具 ───────────────────────────────────────────────────────────

/**
 * ST 使用 express-session：登录后通过 Set-Cookie 下发 connect.sid。
 * 此函数以管理员身份登录，返回完整的 Cookie 字符串（供后续 admin API 使用）。
 *
 * 注意：ST /api/users/login 返回 { handle: '...' }，无 bearer token。
 * 鉴权凭证完全在 Set-Cookie 里（connect.sid=...）。
 */
async function getAdminSessionCookie(): Promise<string> {
  const url = `${config.ST_BASE_URL}/api/users/login`;
  const csrf = await fetchCsrfToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: csrf.cookie,
      'X-CSRF-Token': csrf.token,
    },
    body: JSON.stringify({
      handle: config.ST_ADMIN_USERNAME,
      password: config.ST_ADMIN_PASSWORD,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new StUserError(`ST 管理员登录失败（${res.status}）：${text}`);
  }

  // ST 通过 Set-Cookie 传 connect.sid
  const responseCookies = res.headers.getSetCookie?.() ?? [];
  const fallback = res.headers.get('set-cookie');
  if (responseCookies.length === 0 && fallback) responseCookies.push(fallback);
  const allCookies = [...csrf.setCookies, ...responseCookies];
  if (allCookies.length === 0) {
    throw new StUserError('ST 管理员登录响应中未包含 Set-Cookie，无法建立 session');
  }

  // ST 使用 cookie-session，会同时下发 session + session.sig 两个 cookie
  // 必须同时携带两个 cookie，ST 才能通过签名校验，否则返回 403
  // 使用 getSetCookie() 获取所有 Set-Cookie 行，提取各自的 name=value 部分后合并
  const cookieValue = mergeCookieHeader(undefined, allCookies);
  if (!cookieValue) {
    throw new StUserError('Set-Cookie 格式异常，无法提取 cookie 值');
  }
  return cookieValue;
}

// ─── 创建用户（幂等） ─────────────────────────────────────────────────────────

export interface CreateUserOptions {
  handle: string;
  displayName: string;
}

export interface CreateUserResult {
  created: boolean; // true = 新建；false = 已存在跳过
}

/**
 * 确保 ST 中存在给定 handle 的用户账号。
 * 幂等：已存在则跳过（不报错）。
 *
 * ST admin 创建用户接口：POST /api/users/create
 * 需要管理员 session cookie（requireAdminMiddleware 校验）。
 */
export async function ensureStUser(opts: CreateUserOptions): Promise<CreateUserResult> {
  const { handle, displayName } = opts;
  const password = deriveUserPassword(handle);

  let adminCookie: string;
  try {
    adminCookie = await getAdminSessionCookie();
  } catch (err) {
    throw new StUserError(`无法获取 ST 管理员 session cookie：${err}`, err);
  }

  const url = `${config.ST_BASE_URL}/api/users/create`;
  const csrf = await fetchCsrfToken(adminCookie);
  adminCookie = csrf.cookie;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: adminCookie,
      'X-CSRF-Token': csrf.token,
    },
    body: JSON.stringify({
      handle,
      name: displayName,
      password,
      role: 'user',
    }),
  });

  // 409 = 用户已存在，视为成功
  if (res.status === 409) {
    return { created: false };
  }

  if (!res.ok) {
    const text = await res.text();
    throw new StUserError(`ST 创建用户 '${handle}' 失败（${res.status}）：${text}`);
  }

  return { created: true };
}

export async function loginStUser(handle: string): Promise<string> {
  const csrf = await fetchCsrfToken();
  const res = await fetch(`${config.ST_BASE_URL}/api/users/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: csrf.cookie,
      'X-CSRF-Token': csrf.token,
    },
    body: JSON.stringify({ handle, password: deriveUserPassword(handle) }),
  });
  if (!res.ok) {
    throw new StUserError(`ST 用户 '${handle}' 登录失败（${res.status}）：${await res.text()}`);
  }
  const responseCookies = res.headers.getSetCookie?.() ?? [];
  const fallback = res.headers.get('set-cookie');
  if (responseCookies.length === 0 && fallback) responseCookies.push(fallback);
  return mergeCookieHeader(csrf.cookie, responseCookies);
}

// ─── 错误类型 ─────────────────────────────────────────────────────────────────
export class StUserError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'StUserError';
  }
}

async function fetchCsrfToken(cookie?: string): Promise<{
  token: string;
  cookie: string;
  setCookies: string[];
}> {
  const res = await fetch(`${config.ST_BASE_URL}/csrf-token`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new StUserError(`ST CSRF token 获取失败（${res.status}）：${text}`);
  }

  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new StUserError('ST CSRF token 响应中缺少 token');
  }

  const setCookies = res.headers.getSetCookie?.() ?? [];
  const fallback = res.headers.get('set-cookie');
  if (setCookies.length === 0 && fallback) setCookies.push(fallback);

  return {
    token: body.token,
    cookie: mergeCookieHeader(cookie, setCookies),
    setCookies,
  };
}

function mergeCookieHeader(existing: string | undefined, setCookies: string[]): string {
  const parts = new Map<string, string>();

  for (const part of existing?.split(';') ?? []) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    parts.set(trimmed.slice(0, eq), trimmed);
  }

  for (const setCookie of setCookies) {
    const cookiePart = setCookie.split(';')[0]?.trim();
    if (!cookiePart) continue;
    const eq = cookiePart.indexOf('=');
    if (eq <= 0) continue;
    parts.set(cookiePart.slice(0, eq), cookiePart);
  }

  return Array.from(parts.values()).join('; ');
}
