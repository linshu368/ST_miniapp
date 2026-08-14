/**
 * backend / lib / st-cookie.ts
 *
 * ST session cookie 缓存（Upstash Redis REST）+ fallback 重登。
 * 阶段 4 临时基础设施，阶段 5 user_st_chats 镜像落地后下线。
 */

import { createHmac } from 'node:crypto';
import { config } from '../platform/config.js';

const COOKIE_TTL_SECONDS = 86400; // 24h
const NAMESPACE = 'st_cookie';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ─── Upstash REST helpers ────────────────────────────────────────────────────

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/+$/, '') ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

function isRedisEnabled(): boolean {
  return Boolean(UPSTASH_URL && UPSTASH_TOKEN);
}

async function redisGet(key: string): Promise<string | null> {
  if (!isRedisEnabled()) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: string | null };
    return data.result ?? null;
  } catch {
    return null;
  }
}

async function redisSetex(key: string, ttl: number, value: string): Promise<void> {
  if (!isRedisEnabled()) return;
  try {
    await fetch(`${UPSTASH_URL}/setex/${encodeURIComponent(key)}/${ttl}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value }),
    });
  } catch {
    // best-effort, ignore
  }
}

async function redisDel(key: string): Promise<void> {
  if (!isRedisEnabled()) return;
  try {
    await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
  } catch {
    // best-effort
  }
}

// ─── ST login (duplicated from bridge.ts to avoid circular deps) ─────────────

function deriveUserPassword(handle: string): string {
  return createHmac('sha256', config.stUserPasswordSecret)
    .update(handle)
    .digest('hex')
    .slice(0, 32);
}

async function loginToStInternal(handle: string): Promise<string> {
  const password = deriveUserPassword(handle);
  const csrf = await fetchCsrfToken();
  const res = await fetch(`${config.stBaseUrl}/api/users/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: csrf.cookie,
      'X-CSRF-Token': csrf.token,
    },
    body: JSON.stringify({ handle, password }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ST login failed (${res.status}): ${text}`);
  }

  const allCookies = [...csrf.setCookies, ...(res.headers.getSetCookie?.() ?? [])];
  if (allCookies.length === 0) {
    const fallback = res.headers.get('set-cookie');
    if (!fallback) throw new Error('ST login response missing Set-Cookie');
    allCookies.push(fallback);
  }

  return mergeCookies(allCookies);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * 写入 cookie 缓存（鉴权桥 /st-session 流程内调用）。
 */
export async function cacheStCookie(userId: string, cookie: string): Promise<void> {
  await redisSetex(`${NAMESPACE}:${userId}`, COOKIE_TTL_SECONDS, cookie);
}

/**
 * 获取 ST session cookie。
 * 1. Redis GET → hit → return
 * 2. miss or 401 → fallback: ST login → re-cache → return
 */
export async function getStCookie(userId: string, stHandle: string): Promise<string> {
  const cached = await redisGet(`${NAMESPACE}:${userId}`);
  if (cached) return cached;

  return await refreshStCookie(userId, stHandle);
}

/**
 * 用 cookie 调 ST REST，若 401/403 自动 fallback 重登一次。
 */
export async function fetchWithStCookie<T>(
  userId: string,
  stHandle: string,
  stPath: string,
  init: RequestInit
): Promise<{ ok: boolean; status: number; data: T | null }> {
  let cookie = await getStCookie(userId, stHandle);

  let res = await fetchSt(stPath, cookie, init);

  if (res.status === 401 || res.status === 403) {
    await redisDel(`${NAMESPACE}:${userId}`);
    cookie = await refreshStCookie(userId, stHandle);
    res = await fetchSt(stPath, cookie, init);
  }

  if (!res.ok) {
    return { ok: false, status: res.status, data: null };
  }

  const data = (await res.json()) as T;
  return { ok: true, status: res.status, data };
}

async function fetchSt(path: string, cookie: string, init: RequestInit): Promise<Response> {
  const url = `${config.stBaseUrl}${path}`;
  const method = (init.method ?? 'GET').toUpperCase();
  let requestCookie = cookie;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };

  if (UNSAFE_METHODS.has(method) && !headers['X-CSRF-Token'] && !headers['x-csrf-token']) {
    const csrf = await fetchCsrfToken(cookie);
    requestCookie = csrf.cookie;
    headers['X-CSRF-Token'] = csrf.token;
  }

  headers.Cookie = requestCookie;
  return fetch(url, { ...init, headers });
}

async function refreshStCookie(userId: string, stHandle: string): Promise<string> {
  const cookie = await loginToStInternal(stHandle);
  await cacheStCookie(userId, cookie);
  return cookie;
}

async function fetchCsrfToken(cookie?: string): Promise<{
  token: string;
  cookie: string;
  setCookies: string[];
}> {
  const res = await fetch(`${config.stBaseUrl}/csrf-token`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ST CSRF token failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new Error('ST CSRF token response missing token');
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

function mergeCookies(setCookies: string[]): string {
  return mergeCookieHeader(undefined, setCookies);
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
