/**
 * backend / routes / bridge.ts
 *
 * POST /api/bridge/st-session
 *
 * 完整登录闭环：TG InitData → Supabase user → ST session cookie
 *
 * 调用链（按顺序）：
 *   1. requireTelegramAuth      — 校验 TG InitData 签名，提取 tg_user
 *   2. getOrCreateDbUser        — Prisma upsert + 写 st_handle 到 Supabase
 *   3. 读 users.st_initialized_at — 判断首次 / 再次登录
 *   4. 首次 → 异步触发 provision  — HTTP POST sync-engine /provision/:userId
 *   5. ST 登录                  — POST ST /api/users/login，拿 connect.sid cookie
 *   6. 返回 { st_url, st_cookie } — 前端用于构造 iframe src 或代理请求
 */

import { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { getSupabaseClient } from '../lib/supabase.js';
import { config } from '../platform/config.js';
import { ok, fail } from '@miniapp/shared';
import { deriveStHandle } from '@miniapp/shared';
import { cacheStCookie } from '../lib/st-cookie.js';

// ─── 密码派生（与 sync-engine/provisioner/st-user.ts 保持一致） ──────────────

function deriveUserPassword(handle: string): string {
  if (!config.stUserPasswordSecret) {
    throw new Error('ST_USER_PASSWORD_SECRET 未配置');
  }
  return createHmac('sha256', config.stUserPasswordSecret)
    .update(handle)
    .digest('hex')
    .slice(0, 32);
}

// ─── ST 登录，返回 connect.sid cookie ────────────────────────────────────────

async function loginToSt(handle: string): Promise<string> {
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
    throw new Error(`ST 登录失败（${res.status}）：${text}`);
  }

  // ST 使用 cookie-session，同时下发 session + session.sig 两个 cookie
  // 必须同时携带两个，ST 才能通过签名校验（否则 403）
  // getSetCookie() 返回所有 Set-Cookie 行的数组（Node 18+）
  const allCookies = [...csrf.setCookies, ...(res.headers.getSetCookie?.() ?? [])];
  if (allCookies.length === 0) {
    // 降级：尝试 get('set-cookie')
    const fallback = res.headers.get('set-cookie');
    if (!fallback) throw new Error('ST 登录响应中缺少 Set-Cookie，无法获取 session');
    allCookies.push(fallback);
  }

  const cookiePart = mergeCookieHeader(undefined, allCookies);

  if (!cookiePart) {
    throw new Error('Set-Cookie 格式异常，无法提取 cookie 值');
  }
  return cookiePart;
}

async function fetchCsrfToken(): Promise<{ token: string; cookie: string; setCookies: string[] }> {
  const res = await fetch(`${config.stBaseUrl}/csrf-token`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ST CSRF token 获取失败（${res.status}）：${text}`);
  }

  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new Error('ST CSRF token 响应中缺少 token');
  }

  const setCookies = res.headers.getSetCookie?.() ?? [];
  const fallback = res.headers.get('set-cookie');
  if (setCookies.length === 0 && fallback) setCookies.push(fallback);

  return {
    token: body.token,
    cookie: mergeCookieHeader(undefined, setCookies),
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

// ─── 同步触发 provision（新用户首次登录，等待 ST 账号创建完成） ──────────────

async function triggerProvisionSync(
  userId: string,
  log: (msg: string) => void,
  force = false
): Promise<void> {
  const forceQuery = force ? '?force=true' : '';
  const url = `${config.stProvisionUrl}/provision/${encodeURIComponent(userId)}/sync${forceQuery}`;
  log(`[bridge] 新用户同步 provision 开始（userId=${userId}, force=${force}）`);
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`provision 失败（${res.status}）：${text}`);
  }
  log(`[bridge] 新用户同步 provision 完成（userId=${userId}）`);
}

// ─── 路由注册 ─────────────────────────────────────────────────────────────────

export default async function bridgeRoutes(app: FastifyInstance) {
  /**
   * POST /api/bridge/st-session
   *
   * Request headers:
   *   X-Init-Data: <TG initData string>
   *
   * Response:
   *   {
   *     success: true,
   *     data: {
   *       st_url: string,       // Bridge 反向代理地址（前端 iframe src 前缀）
   *       st_cookie: string,    // connect.sid=xxx（前端通过 proxy 自动携带，此处仅调试用）
   *       is_new_user: boolean, // 首次登录（provision 正在异步执行中）
   *     }
   *   }
   */
  app.post(
    '/api/bridge/st-session',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      }

      const log = (msg: string) => request.log.info(msg);

      try {
        // ── 1. 获取/创建 Supabase 用户，写入 st_handle ────────────────────
        const dbUser = await getOrCreateDbUser(request.user);
        const tgIdStr = request.user.id.toString();
        const stHandle = deriveStHandle(tgIdStr);

        // ── 2. 读 st_initialized_at 判断是否首次登录 ───────────────────────
        const db = getSupabaseClient();
        const { data: userData } = await db
          .from('users')
          .select('st_initialized_at')
          .eq('id', dbUser.id)
          .single();

        const isNewUser = !(userData as { st_initialized_at: string | null } | null)
          ?.st_initialized_at;

        // ── 3. 新用户：两阶段 provision（先让 ST 初始化完整目录，再覆盖平台文件）
        //    再次登录：异步 provision（不阻塞登录流程）
        //
        // 新用户两阶段说明（修复 ST content initialization 覆盖问题）：
        //   阶段 1：force=false provision → 仅创建 ST 账号（ensureStUser），
        //           写入最小文件让 ST 能成功登录
        //   阶段 2：loginToSt → 触发 ST 原生 content initialization，
        //           ST 会建出 NovelAI Settings / TextGen Settings 等完整目录结构
        //   阶段 3：force=true provision → 在 ST 完整目录上覆盖写平台文件
        //           （settings.json / characters / presets / secrets.json）
        if (isNewUser) {
          log(`[bridge] 新用户首次登录（handle=${stHandle}）`);

          // 阶段 1：创建 ST 账号 + 写最小平台文件
          log(`[bridge]   阶段 1/3：创建 ST 账号 + 初始下发`);
          await triggerProvisionSync(dbUser.id, log);

          // 阶段 2：登录 ST，触发 ST 原生 content initialization（建完整目录）
          log(`[bridge]   阶段 2/3：登录 ST，等待 content initialization 完成`);
          const stCookieInit = await loginToSt(stHandle);
          // ST content initialization 是同步的（login 返回时已完成），
          // 但为保险起见等待 500ms 让文件写入落盘
          await new Promise((resolve) => setTimeout(resolve, 500));

          // 阶段 3：force=true 覆盖写平台文件（盖住 ST 的默认 settings.json）
          log(`[bridge]   阶段 3/3：force 覆盖写平台文件`);
          await triggerProvisionSync(dbUser.id, log, true);

          // ── 4. 缓存 cookie + 返回 ──────────────────────────────────
          await cacheStCookie(dbUser.id, stCookieInit);
          return reply.send(
            ok({
              st_url: '/api/bridge/st',
              st_cookie: stCookieInit,
              is_new_user: isNewUser,
            })
          );
        } else {
          log(`[bridge] 已初始化用户再次登录（handle=${stHandle}）`);
          await triggerProvisionSync(dbUser.id, log, true);
        }

        // ── 4. 登录 ST，获取 session cookie（老用户路径）───────────────
        const stCookie = await loginToSt(stHandle);

        // ── 5. 缓存 cookie + 返回结果 ──────────────────────────────────
        await cacheStCookie(dbUser.id, stCookie);
        return reply.send(
          ok({
            st_url: '/api/bridge/st',
            st_cookie: stCookie,
            is_new_user: isNewUser,
          })
        );
      } catch (err) {
        request.log.error({ err: String(err) }, '[bridge] st-session 失败');
        return reply.status(500).send(fail('INTERNAL_ERROR', String(err)));
      }
    }
  );
}
