import type { FastifyInstance } from 'fastify';
import {
  fail,
  isVipActiveAt,
  ok,
  RecordGrowthPromptEventRequestSchema,
  vipCheckinBonusCredits,
  type GetGrowthPromptsData,
  type GrowthPrompt,
  type RecordGrowthPromptEventData,
} from '@miniapp/shared';

import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUserRecord } from '../lib/user.js';
import { readOfficialCommunityConfig } from '../features/community/config.js';
import { isInCommunityByReceipts, readCommunityClaimFacts } from '../features/community/facts.js';
import {
  canShowAgain,
  isCommunityPromptEligible,
  isVipPromptEligible,
  PROMPT_AT_ROUNDS,
  promptCap,
} from '../features/growth/prompt-rules.js';
import { readVipStrategy } from '../platform/vip-strategy.js';
import { GrowthPromptRepository } from '../infrastructure/repositories/GrowthPromptRepository.js';

const repository = new GrowthPromptRepository();

/** 社群开启时才读领奖与在群事实；未配置就不弹进群。 */
async function readCommunityPrompt(
  userId: string,
  telegramUserId: string
): Promise<GrowthPrompt | null> {
  const community = await readOfficialCommunityConfig();
  const configured = community.enabled && Boolean(community.chatId && community.startedAt);
  if (!configured) return null;
  const [facts, inGroup] = await Promise.all([
    readCommunityClaimFacts(userId, telegramUserId, community.chatId),
    isInCommunityByReceipts(telegramUserId, community.chatId),
  ]);
  const eligible = isCommunityPromptEligible({
    configured,
    claimed: Boolean(facts.grantedAt),
    excluded: facts.excluded,
    inGroup,
  });
  if (!eligible) return null;
  return {
    kind: 'community',
    at_rounds: PROMPT_AT_ROUNDS.community,
    reward_credits: community.rewardCredits,
    telegram_url: community.url,
    fallback_handle: community.handle,
  };
}

async function readVipPrompt(vipValidUntil: string | null): Promise<GrowthPrompt | null> {
  const strategy = await readVipStrategy();
  const vipActive = isVipActiveAt(vipValidUntil, new Date().toISOString());
  if (!isVipPromptEligible({ purchaseEnabled: strategy.purchaseEnabled, vipActive })) return null;
  const plan = strategy.plans.month;
  return {
    kind: 'vip',
    at_rounds: PROMPT_AT_ROUNDS.vip,
    price_cents: plan.price_cents,
    duration_days: plan.duration_days,
    bonus_credits: plan.bonus_credits + (plan.bonus_main_credits ?? 0),
    checkin_daily_credits: vipCheckinBonusCredits({ config: strategy.checkin, vipActive: true }),
  };
}

export default async function growthPromptRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get('/api/growth/prompts', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const started = Date.now();
    try {
      const user = await getOrCreateDbUserRecord(request.user);
      const [states, payment] = await Promise.all([
        repository.readStates(user.id),
        repository.readPaymentFacts(user.id),
      ]);
      const [community, vip] = await Promise.all([
        canShowAgain(states.get('community'), promptCap('community', payment.hasPaid), started)
          ? readCommunityPrompt(user.id, String(request.user.id))
          : null,
        canShowAgain(states.get('vip'), promptCap('vip', payment.hasPaid), started)
          ? readVipPrompt(payment.vipValidUntil)
          : null,
      ]);
      const prompts = [community, vip].filter((prompt): prompt is GrowthPrompt => prompt !== null);
      request.log.info(
        {
          event: 'growth.prompts.read',
          prompts: prompts.map((prompt) => prompt.kind),
          duration_ms: Date.now() - started,
        },
        'growth prompts read'
      );
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(ok<GetGrowthPromptsData>({ total_rounds: Number(user.total_round) || 0, prompts }));
    } catch (err) {
      request.log.warn(
        { err, event: 'growth.prompts.read_failed', duration_ms: Date.now() - started },
        'growth prompts unavailable'
      );
      return reply.status(503).send(fail('GROWTH_PROMPTS_UNAVAILABLE', '暂时无法读取'));
    }
  });

  // @frontend-ready: true
  app.post(
    '/api/growth/prompts/events',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const body = RecordGrowthPromptEventRequestSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send(fail('INVALID_REQUEST', '参数不正确'));
      const started = Date.now();
      const { kind, event } = body.data;
      try {
        const user = await getOrCreateDbUserRecord(request.user);
        // 付费只影响 VIP 的展示次数；进群不必多读一次钱包。
        const hasPaid =
          kind === 'vip' && event === 'shown'
            ? (await repository.readPaymentFacts(user.id)).hasPaid
            : false;
        const recorded = await repository.recordEvent(
          user.id,
          kind,
          event,
          promptCap(kind, hasPaid)
        );
        request.log.info(
          {
            event: 'growth.prompt.event',
            kind,
            action: event,
            recorded,
            duration_ms: Date.now() - started,
          },
          'growth prompt event'
        );
        return reply.send(ok<RecordGrowthPromptEventData>({ recorded }));
      } catch (err) {
        request.log.warn(
          { err, event: 'growth.prompt.event_failed', kind, action: event },
          'growth prompt event failed'
        );
        return reply.status(503).send(fail('GROWTH_PROMPTS_UNAVAILABLE', '暂时无法记录'));
      }
    }
  );
}
