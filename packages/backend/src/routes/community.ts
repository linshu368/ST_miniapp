import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  fail,
  ok,
  type CommunityEntryData,
  type VerifyCommunityMembershipData,
} from '@miniapp/shared';
import { config } from '../platform/config.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { getDomainDb } from '../lib/supabase.js';
import { readOfficialCommunityConfig } from '../features/community/config.js';
import {
  getCommunityMemberStatus,
  isActiveCommunityMember,
} from '../features/community/telegram-client.js';

interface CommunityUpdate {
  update_id?: number;
  chat_member?: {
    date?: number;
    chat?: { id?: number };
    old_chat_member?: { status?: string };
    new_chat_member?: { status?: string; user?: { id?: number } };
  };
}
type GrantRow = {
  status: 'rewarded' | 'already_rewarded' | 'ineligible' | 'disabled';
  credits: number;
  granted_at: string | null;
};

export default async function communityRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get('/api/community/entry', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const [community, user] = await Promise.all([
      readOfficialCommunityConfig(),
      getOrCreateDbUser(request.user),
    ]);
    const [claim, exclusion] = community.chatId
      ? await Promise.all([
          getDomainDb('miniapp_features')
            .from('community_reward_claims')
            .select('granted_at')
            .eq('user_id', user.id)
            .eq('community_chat_id', community.chatId)
            .maybeSingle(),
          getDomainDb('miniapp_features')
            .from('community_reward_exclusions')
            .select('telegram_user_id')
            .eq('community_chat_id', community.chatId)
            .eq('telegram_user_id', String(request.user.id))
            .maybeSingle(),
        ])
      : [
          { data: null, error: null },
          { data: null, error: null },
        ];
    if (claim.error || exclusion.error) {
      request.log.error({ err: claim.error ?? exclusion.error }, '[community] entry query failed');
      return reply.status(500).send(fail('INTERNAL', '查询奖励失败'));
    }
    return reply.send(
      ok<CommunityEntryData>({
        enabled: community.enabled && Boolean(community.chatId && community.startedAt),
        title: community.title,
        description: community.description,
        reward_credits: community.rewardCredits,
        telegram_url: community.url,
        fallback_handle: community.handle,
        claim_status: resolveCommunityClaimStatus(Boolean(claim.data), Boolean(exclusion.data)),
        rewarded_at: claim.data?.granted_at ?? null,
      })
    );
  });

  // @frontend-ready: true
  app.post(
    '/api/community/verify-membership',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const community = await readOfficialCommunityConfig();
      if (!community.enabled || !community.chatId || !community.startedAt)
        return reply.send(
          ok<VerifyCommunityMembershipData>({
            status: 'disabled',
            reward_credits: community.rewardCredits,
            rewarded_at: null,
          })
        );
      if (!config.telegramCommunityBotToken)
        return reply.status(503).send(fail('UNAVAILABLE', '社群验证暂不可用'));
      const user = await getOrCreateDbUser(request.user);
      try {
        const member = await getCommunityMemberStatus(
          config.telegramCommunityBotToken,
          community.chatId,
          String(request.user.id)
        );
        if (!isActiveCommunityMember(member))
          return reply.send(
            ok<VerifyCommunityMembershipData>({
              status: 'not_member',
              reward_credits: community.rewardCredits,
              rewarded_at: null,
            })
          );
        const existingMember = await getDomainDb('miniapp_features')
          .from('community_reward_exclusions')
          .select('telegram_user_id')
          .eq('community_chat_id', community.chatId)
          .eq('telegram_user_id', String(request.user.id))
          .maybeSingle();
        if (existingMember.error) throw existingMember.error;
        if (!existingMember.data)
          return reply.send(
            ok<VerifyCommunityMembershipData>({
              status: 'ineligible',
              reward_credits: community.rewardCredits,
              rewarded_at: null,
            })
          );
        return reply.send(
          ok(
            await grant(
              user.id,
              String(request.user.id),
              community.chatId,
              community.rewardCredits,
              null
            )
          )
        );
      } catch (err) {
        request.log.error({ err }, '[community] verify failed');
        return reply.status(502).send(fail('UPSTREAM', '社群验证失败，请稍后重试'));
      }
    }
  );

  // @frontend-ready: false - Telegram Community Bot webhook
  app.post('/api/telegram/community-webhook', async (request, reply) => {
    if (
      !secretMatches(
        request.headers['x-telegram-bot-api-secret-token'],
        deriveCommunityWebhookSecret(config.telegramCommunityBotToken)
      )
    )
      return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const update = (request.body ?? {}) as CommunityUpdate;
    const event = update.chat_member;
    const telegramUserId = event?.new_chat_member?.user?.id;
    const chatId = event?.chat?.id;
    const occurredAt = event?.date ? new Date(event.date * 1000) : null;
    if (
      !isValidTelegramUpdateIdentity(update.update_id, telegramUserId, chatId) ||
      !occurredAt ||
      Number.isNaN(occurredAt.getTime())
    )
      return reply.send(ok({ ignored: true }));
    const community = await readOfficialCommunityConfig();
    const oldStatus = event?.old_chat_member?.status ?? 'unknown';
    const newStatus = event?.new_chat_member?.status ?? 'unknown';
    const eligible = isEligibleJoinTransition({
      enabled: community.enabled,
      configuredChatId: community.chatId,
      startedAt: community.startedAt,
      eventChatId: String(chatId),
      occurredAt,
      oldStatus,
      newStatus,
    });
    const exclusion = eligible
      ? await getDomainDb('miniapp_features')
          .from('community_reward_exclusions')
          .select('telegram_user_id')
          .eq('community_chat_id', String(chatId))
          .eq('telegram_user_id', String(telegramUserId))
          .maybeSingle()
      : { data: null, error: null };
    if (exclusion.error) {
      request.log.error({ err: exclusion.error }, '[community] exclusion query failed');
      return reply.status(500).send(fail('INTERNAL', 'Webhook processing failed'));
    }
    const finalEligible = eligible && !exclusion.data;
    const receipt = await getDomainDb('miniapp_features')
      .from('telegram_community_update_receipts')
      .insert({
        update_id: update.update_id,
        community_chat_id: String(chatId),
        telegram_user_id: String(telegramUserId),
        old_status: oldStatus,
        new_status: newStatus,
        occurred_at: occurredAt.toISOString(),
        eligible: finalEligible,
        result: finalEligible ? 'eligible' : 'ignored',
      })
      .select('update_id')
      .single();
    if (receipt.error) {
      // update_id 的主键插入权就是处理权；重投不能再次进入发奖及其前置副作用。
      if (isUniqueViolation(receipt.error))
        return reply.send(ok({ ignored: true, duplicate: true }));
      request.log.error({ err: receipt.error }, '[community] receipt failed');
      return reply.status(500).send(fail('INTERNAL', 'Webhook processing failed'));
    }
    if (!finalEligible) return reply.send(ok({ ignored: true }));
    const receiptId = receipt.data.update_id;
    const user = await getDomainDb('app_core')
      .from('users')
      .select('id')
      .eq('tg_id', String(telegramUserId))
      .maybeSingle();
    if (user.error) {
      await markReceiptFailed(receiptId, request.log, user.error);
      return reply.send(ok({ ignored: false, matched: false, status: 'failed' }));
    }
    if (!user.data) {
      const unmatched = await getDomainDb('miniapp_features')
        .from('telegram_community_update_receipts')
        .update({ result: 'unmatched' })
        .eq('update_id', receiptId);
      if (unmatched.error) {
        request.log.error(
          { err: unmatched.error, updateId: receiptId },
          '[community] unmatched receipt update failed'
        );
        return reply.send(ok({ ignored: false, matched: false, status: 'failed' }));
      }
      return reply.send(ok({ ignored: false, matched: false }));
    }
    let result: VerifyCommunityMembershipData;
    try {
      result = await grant(
        user.data.id,
        String(telegramUserId),
        community.chatId,
        community.rewardCredits,
        receiptId
      );
    } catch (err) {
      await markReceiptFailed(receiptId, request.log, err);
      // 收据保留失败事实，交由人工补偿；返回 2xx 防止 Telegram 持续重投打库。
      return reply.send(ok({ ignored: false, matched: true, status: 'failed' }));
    }
    const processed = await getDomainDb('miniapp_features')
      .from('telegram_community_update_receipts')
      .update({ result: result.status, processed_at: new Date().toISOString() })
      .eq('update_id', receiptId);
    if (processed.error) {
      // RPC 已提交时绝不能把收据改写为 failed；记录 update_id 供对账修复。
      request.log.error(
        { err: processed.error, updateId: receiptId },
        '[community] rewarded receipt update failed'
      );
    }
    return reply.send(ok({ ignored: false, matched: true, status: result.status }));
  });
}

export function isValidTelegramUpdateIdentity(
  updateId: number | undefined,
  telegramUserId: number | undefined,
  chatId: number | undefined
): boolean {
  return (
    Number.isSafeInteger(updateId) &&
    Number.isSafeInteger(telegramUserId) &&
    Number.isSafeInteger(chatId) &&
    telegramUserId! > 0 &&
    chatId !== 0
  );
}

export function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === '23505';
}

async function markReceiptFailed(
  updateId: number,
  log: { error: (bindings: { err: unknown; updateId?: number }, message: string) => void },
  err: unknown
): Promise<void> {
  const failed = await getDomainDb('miniapp_features')
    .from('telegram_community_update_receipts')
    .update({ result: 'failed', processed_at: new Date().toISOString() })
    .eq('update_id', updateId);
  if (failed.error)
    log.error({ err: failed.error, updateId }, '[community] failed receipt update failed');
  log.error({ err, updateId }, '[community] reward failed');
}

async function grant(
  userId: string,
  telegramUserId: string,
  chatId: string,
  credits: number,
  updateId: number | null
): Promise<VerifyCommunityMembershipData> {
  const { data, error } = await getDomainDb('miniapp_features').rpc('grant_community_join_reward', {
    p_user_id: userId,
    p_telegram_user_id: telegramUserId,
    p_community_chat_id: chatId,
    p_reward_credits: credits,
    p_telegram_update_id: updateId,
  });
  if (error) throw error;
  const row = (data as GrantRow[] | null)?.[0];
  if (!row) throw new Error('community reward RPC returned no row');
  return { status: row.status, reward_credits: row.credits, rewarded_at: row.granted_at };
}

export function resolveCommunityClaimStatus(
  hasClaim: boolean,
  isExistingMember: boolean
): CommunityEntryData['claim_status'] {
  if (hasClaim) return 'rewarded';
  return isExistingMember ? 'existing_member' : 'unclaimed';
}

export function secretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Telegram secret_token 不接受 Bot token 中的冒号，因此从唯一配置的 Bot token
 * 确定性派生 64 位十六进制值。注册 setWebhook 时必须使用同一算法的结果。
 */
export function deriveCommunityWebhookSecret(botToken: string): string {
  return botToken ? createHash('sha256').update(botToken).digest('hex') : '';
}

export function isEligibleJoinTransition(input: {
  enabled: boolean;
  configuredChatId: string;
  startedAt: string | null;
  eventChatId: string;
  occurredAt: Date;
  oldStatus: string;
  newStatus: string;
}): boolean {
  return (
    input.enabled &&
    Boolean(input.configuredChatId && input.startedAt) &&
    input.eventChatId === input.configuredChatId &&
    input.occurredAt.getTime() >= Date.parse(input.startedAt!) &&
    !isActiveCommunityMember(input.oldStatus) &&
    isActiveCommunityMember(input.newStatus)
  );
}
