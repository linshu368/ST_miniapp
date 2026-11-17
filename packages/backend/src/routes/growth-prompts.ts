import type { FastifyInstance } from 'fastify';
import {
  fail,
  ok,
  RecordGrowthPromptEventRequestSchema,
  vipCheckinBonusCredits,
  type GetGrowthPromptsData,
  type GrowthPrompt,
  type RecordGrowthPromptEventData,
} from '@miniapp/shared';

import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUserRecord, type MiniappDbUser } from '../lib/user.js';
import { readOfficialCommunityConfig } from '../features/community/config.js';
import { isInCommunityByReceipts, readCommunityClaimFacts } from '../features/community/facts.js';
import {
  canShowAgain,
  isCommunityPromptEligible,
  pickVipPromptContext,
  PROMPT_AT_ROUNDS,
  promptCap,
  vipPromptCap,
  type PromptState,
} from '../features/growth/prompt-rules.js';
import { evaluateFreeZoneAccess } from '../features/free-zone/access.js';
import { fetchFreeZoneConfig } from '../features/free-zone/config.js';
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

/**
 * VIP 弹窗跟着畅聊按身份开放走：先判场景（刚结束 / 畅聊日），再看频次。
 * 只看会员到期与注册时间，非会员不需要开通记录。
 */
async function readVipPrompt(input: {
  user: MiniappDbUser;
  vipValidUntil: string | null;
  state: PromptState | undefined;
  now: Date;
}): Promise<{ prompt: GrowthPrompt | null; context: string | null }> {
  const [strategy, config] = await Promise.all([readVipStrategy(), fetchFreeZoneConfig()]);
  if (!config.enabled || !config.access.enabled) return { prompt: null, context: null };
  const access = evaluateFreeZoneAccess({
    config,
    now: input.now,
    facts: {
      createdAt: input.user.created_at,
      vipValidUntil: input.vipValidUntil,
      lastVipGrantAt: null,
    },
  });
  const picked = pickVipPromptContext({
    purchaseEnabled: strategy.purchaseEnabled,
    access,
    state: input.state,
  });
  if (!picked) return { prompt: null, context: null };
  if (
    !canShowAgain(input.state, vipPromptCap(input.state, config.access.prompt), input.now.getTime())
  ) {
    return { prompt: null, context: picked.context };
  }
  const plan = strategy.plans.month;
  const totalRounds = Number(input.user.total_round) || 0;
  return {
    context: picked.context,
    prompt: {
      kind: 'vip',
      // 「刚结束」要等用户被切到付费、完成一轮之后再弹；畅聊日一打开就弹。
      at_rounds: picked.afterNextRound ? totalRounds + 1 : 0,
      price_cents: plan.price_cents,
      duration_days: plan.duration_days,
      bonus_credits: plan.bonus_credits + (plan.bonus_main_credits ?? 0),
      bonus_main_credits: plan.bonus_main_credits ?? 0,
      checkin_daily_credits: vipCheckinBonusCredits({ config: strategy.checkin, vipActive: true }),
      context: picked.context,
      welcome_days: config.access.vip_welcome_days,
      vip_day: { ...config.access.vip_weekly },
    },
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
        canShowAgain(states.get('community'), promptCap('community'), started)
          ? readCommunityPrompt(user.id, String(request.user.id))
          : null,
        readVipPrompt({
          user,
          vipValidUntil: payment.vipValidUntil,
          state: states.get('vip'),
          now: new Date(started),
        }),
      ]);
      const prompts = [community, vip.prompt].filter(
        (prompt): prompt is GrowthPrompt => prompt !== null
      );
      request.log.info(
        {
          event: 'growth.prompts.read',
          community_prompt: prompts.some((prompt) => prompt.kind === 'community'),
          vip_prompt: prompts.some((prompt) => prompt.kind === 'vip'),
          // 有场景但被频次挡住时也记下来，方便看弹窗为什么没出
          vip_context: vip.context,
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
        // VIP 的上限按当前次数算（每批之后换成冷却期），展示时现读一次状态与频次参数。
        const cap =
          kind === 'vip' && event === 'shown'
            ? await (async () => {
                const [states, config] = await Promise.all([
                  repository.readStates(user.id),
                  fetchFreeZoneConfig(),
                ]);
                return vipPromptCap(states.get('vip'), config.access.prompt);
              })()
            : promptCap(kind);
        const recorded = await repository.recordEvent(user.id, kind, event, cap);
        request.log.info(
          {
            event: 'growth.prompt.event',
            kind: 'biz',
            prompt_kind: kind,
            action: event,
            recorded,
            duration_ms: Date.now() - started,
          },
          'growth prompt event'
        );
        return reply.send(ok<RecordGrowthPromptEventData>({ recorded }));
      } catch (err) {
        request.log.warn(
          {
            err,
            event: 'growth.prompt.event_failed',
            kind: 'sys',
            prompt_kind: kind,
            action: event,
          },
          'growth prompt event failed'
        );
        return reply.status(503).send(fail('GROWTH_PROMPTS_UNAVAILABLE', '暂时无法记录'));
      }
    }
  );
}
