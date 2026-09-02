/**
 * backend / routes / invite.ts
 *
 * 裂变邀请（invite program）C 端接口。
 * 设计依据：docs/裂变工程落地实施方案.md + docs/裂变阶段一实施计划.md。
 *
 * 数据侧全部收敛在 migration 105 的三张 miniapp_traffic 表与三个 SECURITY DEFINER RPC；
 * 本文件不做任何手动余额加减，发奖只发生在 bind_invite → grant_invite_reward 事务内。
 */

import { FastifyInstance } from 'fastify';
import {
  fail,
  ok,
  INVITE_SOURCE_ID,
  INVITE_START_PARAM_PREFIX,
  type InviteBindData,
  type InviteBindRequest,
  type InviteBindStatus,
  type InviteCenterViewData,
  type InviteEntryStatusData,
  type InviteRewardRecord,
  type InviteStatsData,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { getDomainDb } from '../lib/supabase.js';
import { fetchRuntimeConfigEntry } from '../platform/runtime-config.js';
import { buildMiniappDeepLink } from '../lib/telegram-links.js';

const ENTRY_ENABLED_CONFIG_KEY = 'miniapp_invite_entry_enabled';
const CENTER_CONFIG_KEY = 'miniapp_invite_center_config';

/** 与 105 迁移中 invite_codes.code 的 CHECK 一致；大小写在 RPC 内归一。 */
const INVITE_CODE_RE = /^[A-Za-z0-9]{8}$/;

/**
 * 把请求体里的 invite_code 收窄成"可安全交给 RPC 的码"，否则返回 null。
 *
 * 客户端可能送来任意 JSON 类型（数字、对象、null）：先判 string 再 trim，
 * 不然非字符串会在 .trim() 处抛 TypeError 变成 500。调用方对 null 统一按
 * invalid_code 返回——这是终态，前端不会重试。
 */
export function normalizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return INVITE_CODE_RE.test(trimmed) ? trimmed : null;
}

const RECENT_REWARDS_LIMIT = 10;

interface InviteCenterConfigValue {
  poster_url?: unknown;
  copy_templates?: unknown;
}

export default async function inviteRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get(
    '/api/invite/entry-status',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      }

      const dbUser = await getOrCreateDbUser(request.user);
      const [entryEnabled, codeRow] = await Promise.all([
        readEntryEnabled(),
        getDomainDb('miniapp_traffic')
          .from('invite_codes')
          .select('center_first_entered_at')
          .eq('user_id', dbUser.id)
          .maybeSingle(),
      ]);

      if (codeRow.error) {
        request.log.error({ err: codeRow.error }, '[Invite] 查询邀请码记录失败');
        return reply.status(500).send(fail('INTERNAL', '查询邀请入口状态失败'));
      }

      return reply.send(
        ok<InviteEntryStatusData>({
          entry_enabled: entryEnabled,
          center_entered: Boolean(codeRow.data?.center_first_entered_at),
        })
      );
    }
  );

  // @frontend-ready: true
  app.post(
    '/api/invite/center-view',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      }

      const dbUser = await getOrCreateDbUser(request.user);
      const { data, error } = await getDomainDb('miniapp_traffic').rpc('ensure_invite_code', {
        p_user_id: dbUser.id,
      });
      if (error) {
        request.log.error({ err: error }, '[Invite] ensure_invite_code 失败');
        return reply.status(500).send(fail('INTERNAL', '获取邀请码失败'));
      }

      const row = (data as Array<{ code: string; first_visit: boolean }> | null)?.[0];
      if (!row) {
        return reply.status(500).send(fail('INTERNAL', '获取邀请码失败'));
      }

      const [centerConfig, inviteLink] = await Promise.all([
        readCenterConfig(),
        buildMiniappDeepLink(`${INVITE_START_PARAM_PREFIX}${row.code}`),
      ]);
      if (!inviteLink) {
        // 本地 MOCK_AUTH 等无 bot token 场景返回空串，前端降级展示。
        request.log.warn('[Invite] bot username 不可用，专属链接降级为空');
      }

      return reply.send(
        ok<InviteCenterViewData>({
          invite_code: row.code,
          invite_link: inviteLink ?? '',
          poster_url: centerConfig.posterUrl,
          copy_templates: centerConfig.copyTemplates,
          first_visit: row.first_visit,
        })
      );
    }
  );

  // @frontend-ready: true
  app.post('/api/invite/bind', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    }

    const body = (request.body ?? {}) as Partial<InviteBindRequest>;
    const inviteCode = normalizeInviteCode(body.invite_code);
    if (inviteCode === null) {
      return reply.send(ok<InviteBindData>({ status: 'invalid_code' }));
    }

    const dbUser = await getOrCreateDbUser(request.user);
    const { data, error } = await getDomainDb('miniapp_traffic').rpc('bind_invite', {
      p_invitee_user_id: dbUser.id,
      p_invite_code: inviteCode,
    });
    if (error) {
      request.log.error({ err: error }, '[Invite] bind_invite 失败');
      return reply.status(500).send(fail('INTERNAL', '绑定邀请关系失败'));
    }

    const row = (data as Array<{ status: InviteBindStatus }> | null)?.[0];
    const status: InviteBindStatus = row?.status ?? 'invalid_code';

    if (status === 'bound' && !dbUser.source_id) {
      // 邀请流量渠道归因（已拍板 D1）：仅首次、守卫式写入，失败不影响绑定结果。
      const { error: sourceErr } = await getDomainDb('app_core')
        .from('users')
        .update({ source_id: INVITE_SOURCE_ID, updated_at: new Date().toISOString() })
        .eq('id', dbUser.id)
        .is('source_id', null);
      if (sourceErr) {
        request.log.error({ err: sourceErr }, '[Invite] 写入 source_id=invite 失败');
      }
    }

    return reply.send(ok<InviteBindData>({ status }));
  });

  // @frontend-ready: true
  app.get('/api/invite/stats', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    }

    const dbUser = await getOrCreateDbUser(request.user);
    const trafficDb = getDomainDb('miniapp_traffic');

    const [relationCount, rewardRows] = await Promise.all([
      trafficDb
        .from('invite_relations')
        .select('id', { count: 'exact', head: true })
        .eq('inviter_user_id', dbUser.id),
      trafficDb
        .from('invite_reward_logs')
        .select('credits, rule_key, granted_at')
        .eq('inviter_user_id', dbUser.id)
        .order('granted_at', { ascending: false }),
    ]);

    if (relationCount.error || rewardRows.error) {
      request.log.error(
        { err: relationCount.error ?? rewardRows.error },
        '[Invite] 查询邀请数据失败'
      );
      return reply.status(500).send(fail('INTERNAL', '查询邀请数据失败'));
    }

    const rewards = (rewardRows.data ?? []) as InviteRewardRecord[];
    return reply.send(
      ok<InviteStatsData>({
        invited_count: relationCount.count ?? 0,
        total_reward_credits: rewards.reduce((sum, r) => sum + r.credits, 0),
        recent_rewards: rewards.slice(0, RECENT_REWARDS_LIMIT),
        updated_at: new Date().toISOString(),
        update_mode: 'realtime',
      })
    );
  });
}

async function readEntryEnabled(): Promise<boolean> {
  const entry = await fetchRuntimeConfigEntry(ENTRY_ENABLED_CONFIG_KEY);
  return entry?.value === true;
}

async function readCenterConfig(): Promise<{ posterUrl: string; copyTemplates: string[] }> {
  const entry = await fetchRuntimeConfigEntry(CENTER_CONFIG_KEY);
  const value = (entry?.value ?? {}) as InviteCenterConfigValue;
  const posterUrl = typeof value.poster_url === 'string' ? value.poster_url : '';
  const copyTemplates = Array.isArray(value.copy_templates)
    ? value.copy_templates.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : [];
  return { posterUrl, copyTemplates };
}
