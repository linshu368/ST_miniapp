import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { AdminCliSessionRequestSchema, fail, ok, type AdminCliSessionData } from '@miniapp/shared';
import { AdminSessionError, loadAdminActor } from '../features/admin-access/session.js';
import { getSupabaseClient } from '../lib/supabase.js';
import { config } from '../platform/config.js';

/**
 * 运营平台 CLI 免密登录（用户决策 2026-11-04）：只凭白名单邮箱签发该运营账号的会话。
 *
 * 唯一的门槛是 ADMIN_CLI_ALLOWED_EMAILS 白名单——知道该邮箱的人都能拿到会话，这是用户确认过的取舍。
 * 白名单为空时接口直接 404，默认关闭。签发出来的是该账号本人的普通 Supabase 会话：
 * 之后所有写操作仍走数据库函数里的角色、环境权限与审计，不使用 service-role 代写。
 */

const SUPABASE_TIMEOUT_MS = 8_000;
/** 全进程滑动窗口上限：正常使用一天也就几次，超过即视为被刷。 */
const ISSUE_LIMIT = 20;
const ISSUE_WINDOW_MS = 10 * 60_000;

const issuedAt: number[] = [];

function underRateLimit(now: number): boolean {
  while (issuedAt.length > 0 && now - (issuedAt[0] ?? 0) > ISSUE_WINDOW_MS) issuedAt.shift();
  return issuedAt.length < ISSUE_LIMIT;
}

/** 测试用：清空限流窗口。 */
export function resetAdminCliSessionRateLimit(): void {
  issuedAt.length = 0;
}

const timeoutFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(SUPABASE_TIMEOUT_MS)])
      : AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
  });

export default async function adminCliSessionRoutes(app: FastifyInstance) {
  // @frontend-ready: false —— 仅供 packages/admin-cli 登录，不给浏览器使用
  app.post('/api/admin/cli/session', async (request, reply) => {
    const allowed = config.adminCli.allowedEmails;
    if (allowed.length === 0) return reply.status(404).send(fail('NOT_FOUND', 'Not found'));

    const parsed = AdminCliSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(fail('BAD_REQUEST', '需要有效的邮箱'));
    const { email } = parsed.data;
    if (!allowed.includes(email)) {
      request.log.warn(
        { event: 'admin_cli.session.refused', reason: 'not_allowed' },
        'CLI 登录被拒'
      );
      return reply.status(403).send(fail('FORBIDDEN', '该邮箱不允许通过 CLI 登录'));
    }

    const now = Date.now();
    if (!underRateLimit(now)) {
      request.log.warn(
        { event: 'admin_cli.session.refused', reason: 'rate_limited' },
        'CLI 登录被拒'
      );
      return reply.status(429).send(fail('RATE_LIMITED', 'CLI 登录过于频繁，请稍后再试'));
    }

    try {
      // generateLink 只生成一次性凭据、不发邮件；随即在后端兑换成会话。
      const { data: link, error: linkError } = await getSupabaseClient().auth.admin.generateLink({
        type: 'magiclink',
        email,
      });
      const tokenHash = link?.properties?.hashed_token;
      if (linkError || !tokenHash || !link.user) {
        request.log.warn(
          {
            event: 'admin_cli.session.refused',
            reason: 'no_auth_user',
            err: linkError ?? undefined,
          },
          'CLI 登录被拒'
        );
        return reply.status(403).send(fail('FORBIDDEN', '该邮箱没有运营平台账号'));
      }

      // 先确认是当前环境可访问的运营账号，再兑换会话。
      await loadAdminActor(link.user.id, 'read');

      // 兑换必须用一次性 client：在共享的 service-role client 上兑换会把它的身份换成该用户。
      const exchange = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: timeoutFetch },
        // 生产容器是 Node 20，没有原生 WebSocket；supabase-js 创建 client 时就要求提供 transport。
        realtime: { transport: WebSocket as never },
      });
      const { data: verified, error: verifyError } = await exchange.auth.verifyOtp({
        token_hash: tokenHash,
        type: 'magiclink',
      });
      const session = verified?.session;
      if (verifyError || !session) {
        request.log.error(
          { event: 'admin_cli.session.failed', err: verifyError ?? undefined },
          'CLI 会话签发失败'
        );
        return reply.status(502).send(fail('UPSTREAM_ERROR', '会话签发失败，请稍后重试'));
      }

      issuedAt.push(now);
      request.log.info(
        { event: 'admin_cli.session.issued', userId: link.user.id },
        'CLI 会话已签发'
      );
      const data: AdminCliSessionData = {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at ?? null,
        user_id: link.user.id,
      };
      return reply.send(ok(data));
    } catch (error) {
      if (error instanceof AdminSessionError) {
        request.log.warn(
          { event: 'admin_cli.session.refused', reason: 'not_admin' },
          'CLI 登录被拒'
        );
        return reply.status(403).send(fail('FORBIDDEN', '该账号没有当前环境的运营平台权限'));
      }
      request.log.error({ event: 'admin_cli.session.failed', err: error }, 'CLI 会话签发失败');
      return reply.status(500).send(fail('INTERNAL_ERROR', '会话签发失败，请稍后重试'));
    }
  });
}
