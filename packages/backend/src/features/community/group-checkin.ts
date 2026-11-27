import type { FastifyInstance } from 'fastify';
import { fail, ok, type CommunityGroupCheckinData } from '@miniapp/shared';
import { config } from '../../platform/config.js';
import { bindBusinessContext } from '../../platform/observability/context.js';
import { getDomainDb } from '../../lib/supabase.js';
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';

export function parseTelegramUserId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^[1-9]\d{0,19}$/.test(trimmed) ? trimmed : null;
  }
  return null;
}

export function isCheckinAlreadyClaimedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const cause =
    'cause' in err ? (err as { cause?: { code?: string; message?: string } }).cause : undefined;
  if (cause?.code === 'P0001') return true;
  const message = [
    'message' in err && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : '',
    typeof cause?.message === 'string' ? cause.message : '',
  ].join(' ');
  return /daily check-in is not ready/i.test(message);
}

export function registerCommunityGroupCheckin(
  app: FastifyInstance,
  secretMatches: (provided: unknown, expected: string) => boolean
) {
  const wallets = new MiniappWalletRepository();

  // @frontend-ready: false - internal community bot group check-in
  app.post('/api/internal/community/checkin', async (request, reply) => {
    if (
      !secretMatches(request.headers['x-community-bot-secret'], config.communityBotCheckinSecret)
    ) {
      return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    }

    const body = (request.body ?? {}) as { telegram_user_id?: unknown };
    const telegramUserId = parseTelegramUserId(body.telegram_user_id);
    if (!telegramUserId) {
      return reply.status(400).send(fail('BAD_REQUEST', 'telegram_user_id is required'));
    }

    const started = Date.now();
    bindBusinessContext({ telegram_user_id: telegramUserId });

    const user = await getDomainDb('app_core')
      .from('users')
      .select('id')
      .eq('tg_id', telegramUserId)
      .maybeSingle();
    if (user.error) {
      request.log.error(
        {
          err: user.error,
          event: 'community.checkin.user_lookup_failed',
          durationMs: Date.now() - started,
        },
        '[community] group checkin user lookup failed'
      );
      return reply.status(500).send(fail('INTERNAL', '签到查询失败'));
    }
    if (!user.data) {
      request.log.info(
        { event: 'community.checkin.not_registered', durationMs: Date.now() - started },
        '[community] group checkin skipped for unregistered user'
      );
      return reply.send(ok<CommunityGroupCheckinData>({ status: 'not_registered' }));
    }

    bindBusinessContext({ user_id: user.data.id });
    try {
      const result = await wallets.claimDailyCheckin(user.data.id);
      request.log.info(
        {
          event: 'community.checkin.claimed',
          userId: user.data.id,
          rewardCredits: result.checkin.reward_credits,
          durationMs: Date.now() - started,
        },
        '[community] group checkin claimed'
      );
      return reply.send(
        ok<CommunityGroupCheckinData>({
          status: 'claimed',
          reward_credits: result.checkin.reward_credits,
          base_reward_credits: result.checkin.base_reward_credits,
          vip_reward_credits: result.checkin.vip_reward_credits,
          next_claim_at: result.checkin.next_claim_at,
        })
      );
    } catch (err) {
      if (isCheckinAlreadyClaimedError(err)) {
        request.log.info(
          {
            event: 'community.checkin.already_claimed',
            userId: user.data.id,
            durationMs: Date.now() - started,
          },
          '[community] group checkin already claimed today'
        );
        return reply.send(ok<CommunityGroupCheckinData>({ status: 'already_claimed' }));
      }
      request.log.error(
        {
          err,
          event: 'community.checkin.failed',
          userId: user.data.id,
          durationMs: Date.now() - started,
        },
        '[community] group checkin failed'
      );
      return reply.status(500).send(fail('INTERNAL', '签到失败，请稍后重试'));
    }
  });
}
