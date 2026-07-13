/**
 * backend / routes / bridge.ts
 *
 * POST /api/bridge/st-session
 *
 * 完整登录闭环：TG InitData → MiniApp user → ST session cookie
 *
 * 调用链（按顺序）：
 *   1. requireTelegramAuth      — 校验 TG InitData 签名，提取 tg_user
 *   2. getOrCreateDbUser        — 创建 / 读取 miniapp.users
 *   3. 读 miniapp.users.st_initialized_at — 判断首次 / 再次登录
 *   4. 首次 → 异步触发 provision  — HTTP POST sync-engine /provision/:userId
 *   5. ST 登录                  — POST ST /api/users/login，拿 connect.sid cookie
 *   6. 返回 { st_url, st_cookie } — 前端用于构造 iframe src 或代理请求
 */

import { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
import { getSupabaseClient } from '../lib/supabase.js';
import { config } from '../platform/config.js';
import { ok, fail } from '@miniapp/shared';
import { deriveStHandle } from '@miniapp/shared';
import type { EnsureStCharacterData } from '@miniapp/shared';
import { cacheStCookie } from '../lib/st-cookie.js';

const miniappUserSettings = new MiniappUserSettingsRepository();

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

// ─── 同步触发 provision（登录关键路径，等待配置下发完成） ────────────────────
//
// 懒下发策略：登录关键路径默认 cardsNone=true，即只下发配置（settings/secrets/
// presets），不下发角色卡 PNG。角色卡改由前端进入 /tavern/<id> 时经
// POST /api/bridge/st-character/:characterId 按需拉「当前打开的这张」。
// 这样登录不再撞上全量卡下载尖峰（ST 扫目录/生成缩略图 + 网络下载）。
async function triggerProvisionSync(
  userId: string,
  log: (msg: string) => void,
  force = false,
  cardsNone = true
): Promise<void> {
  const params = new URLSearchParams();
  if (force) params.set('force', 'true');
  if (cardsNone) params.set('cards', 'none');
  const query = params.toString();
  const url = `${config.stProvisionUrl}/provision/${encodeURIComponent(userId)}/sync${query ? `?${query}` : ''}`;
  log(`[bridge] 同步 provision 开始（userId=${userId}, force=${force}, cardsNone=${cardsNone}）`);
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`provision 失败（${res.status}）：${text}`);
  }
  log(`[bridge] 同步 provision 完成（userId=${userId}）`);
}

// ─── 异步触发 provision（老用户放行后台刷新，不阻塞关键路径） ──────────────────
//
// 调 provision-api 的异步端点 POST /provision/:userId（立即返回 202，sync-engine
// 后台跑完整 provision）。老用户「先登录拿 cookie 立即放行」后用它刷新配置。
// 必须带 cardsNone=true：provision() 默认 characterScope='all'，若不传 cards=none，
// 后台会给懒下发用户补下全部角色卡，重新制造 CPU/IO 尖峰（与 ST 冷启动抢容器）。
async function triggerProvisionAsync(
  userId: string,
  log: (msg: string) => void,
  force = false,
  cardsNone = true
): Promise<void> {
  const params = new URLSearchParams();
  if (force) params.set('force', 'true');
  if (cardsNone) params.set('cards', 'none');
  const query = params.toString();
  const url = `${config.stProvisionUrl}/provision/${encodeURIComponent(userId)}${query ? `?${query}` : ''}`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`async provision 触发失败（${res.status}）：${text}`);
  }
  log(`[bridge] 后台 provision 已触发（userId=${userId}, force=${force}, cardsNone=${cardsNone}）`);
}

// ─── 单卡按需下发（进入对话页时确保当前卡落盘） ──────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ensureStCharacter(userId: string, characterId: string): Promise<StatusLiteral> {
  const url = `${config.stProvisionUrl}/provision/${encodeURIComponent(userId)}/character/${encodeURIComponent(characterId)}/sync`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ensure character 失败（${res.status}）：${text}`);
  }
  const body = (await res.json()) as { status?: StatusLiteral };
  return body.status ?? 'missing';
}

type StatusLiteral = EnsureStCharacterData['status'];

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
  // @frontend-ready: true
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

        // 落库 TG 身份（名字/头像）到 miniapp_user_settings，供 provision 注入 ST persona。
        // 必须在 provision 前执行，否则 sync-engine 读不到当前用户的名字/头像（回退平台默认）。
        // 非致命：失败仅记录警告，不阻断登录（persona 会退回平台默认）。
        try {
          await miniappUserSettings.getOrCreate(dbUser.id, request.user);
        } catch (err) {
          request.log.warn({ err: String(err) }, '[bridge] 落库 TG persona 失败（不阻断登录）');
        }

        // ── 2. 读 st_initialized_at 判断是否首次登录 ───────────────────────
        const db = getSupabaseClient().schema('miniapp');
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
          // 老/新分流放行（iframe 加载耗时优化 #3）：
          // 老用户配置本已在盘（上次 provision 已写全套），先登录拿 cookie 立即放行，
          // 让前端 iframe 尽早开始加载 ST（与 ST 冷启动并行），provision 改后台异步刷新。
          //   - 依据 1：per-user JWT 永不过期（signPlatformToken 只写 iat 无 exp，
          //             verifyPlatformToken 不校验过期）→ 盘上旧 secrets 仍有效，
          //             首条消息不会撞过期凭证。
          //   - 依据 2：force=false 下 settings/secrets 总是覆盖写、cards/presets
          //             skip-if-exists；后台没跑完时 ST 用旧配置仍有效，最多稍旧，
          //             下次打开生效（ST 本就不热重载 settings.json）。
          //   - cards=none 懒下发保持不变（避免全量卡下载尖峰，见 triggerProvisionAsync）。
          // 原实现是「await 同步 provision → 再登录 → 才放行」，把 provision 耗时串在
          // 关键路径最前面；这里改为「登录拿 cookie 立即放行 + provision 后台异步」。
          log(`[bridge] 已初始化用户再次登录（handle=${stHandle}），先放行 + 后台刷新配置`);

          // iframe 登录必须使用本次 ST 实例新签发的 session。st-bundle 重启后，Redis 中
          // 旧 cookie 可能仍在 TTL 内但已无法通过签名校验，直接复用会让 /tavern 302 到
          // /login，桥接永远无法 ready。这里保留可靠的新登录，并覆盖缓存供 REST 桥使用。
          const stCookie = await loginToSt(stHandle);
          await cacheStCookie(dbUser.id, stCookie);

          // 后台异步刷新配置：不 await；触发失败仅告警（用户已用现有配置放行，不阻断）。
          triggerProvisionAsync(dbUser.id, log).catch((err) => {
            request.log.warn(
              { err: String(err) },
              '[bridge] 后台 provision 触发失败（不阻断放行）'
            );
          });

          return reply.send(
            ok({
              st_url: '/api/bridge/st',
              st_cookie: stCookie,
              is_new_user: isNewUser,
            })
          );
        }
      } catch (err) {
        request.log.error({ err: String(err) }, '[bridge] st-session 失败');
        return reply.status(500).send(fail('INTERNAL_ERROR', String(err)));
      }
    }
  );

  /**
   * POST /api/bridge/st-character/:characterId
   *
   * 懒下发关键路径：前端进入 /tavern/<characterId> 时调用，确保「当前打开的这张卡」
   * 已落到该用户的 ST 数据目录，随后前端才 selectCharacter。登录不再全量下发角色卡。
   *
   * Request headers: X-Init-Data: <TG initData string>
   * Response: { success: true, data: { characterId, status: 'written'|'skipped'|'missing' } }
   */
  // @frontend-ready: true
  app.post(
    '/api/bridge/st-character/:characterId',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      }

      const { characterId } = request.params as { characterId: string };
      if (!UUID_RE.test(characterId)) {
        return reply.status(400).send(fail('INVALID_ARGUMENT', 'characterId 必须是 UUID'));
      }

      try {
        const dbUser = await getOrCreateDbUser(request.user);
        const status = await ensureStCharacter(dbUser.id, characterId);
        return reply.send(ok<EnsureStCharacterData>({ characterId, status }));
      } catch (err) {
        request.log.error({ err: String(err) }, '[bridge] st-character 失败');
        return reply.status(500).send(fail('INTERNAL_ERROR', String(err)));
      }
    }
  );
}
