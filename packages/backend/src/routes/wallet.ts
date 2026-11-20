import { FastifyInstance } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import type {
  GetDailyCheckinData,
  GetWalletBalanceData,
  GetWalletSpendingData,
  PostDailyCheckinData,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { requestLogger } from '../lib/logger.js';
import { getOrCreateDbUser } from '../lib/user.js';
import {
  MiniappWalletRepository,
  toWalletBalance,
} from '../infrastructure/repositories/MiniappWalletRepository.js';
import { readVipStrategy } from '../platform/vip-strategy.js';

export default async function walletRoutes(app: FastifyInstance) {
  const wallets = new MiniappWalletRepository();

  // @frontend-ready: true
  app.get('/api/wallet/balance', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const dbUser = await getOrCreateDbUser(request.user);
    const wallet = await wallets.getOrCreate(dbUser.id);

    return reply.send(ok<GetWalletBalanceData>(toWalletBalance(wallet)));
  });

  // @frontend-ready: true
  app.get('/api/wallet/spending', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const dbUser = await getOrCreateDbUser(request.user);
    return reply.send(ok<GetWalletSpendingData>({ items: await wallets.listSpending(dbUser.id) }));
  });

  // @frontend-ready: true
  app.get('/api/wallet/checkin', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const dbUser = await getOrCreateDbUser(request.user);
    const strategy = await readVipStrategy();
    const checkin = await wallets.getDailyCheckinStatus(dbUser.id, {
      createdAt: dbUser.created_at,
      vipCredits: strategy.checkin,
    });

    return reply.send(ok<GetDailyCheckinData>({ checkin }));
  });

  // @frontend-ready: true
  app.post('/api/wallet/checkin', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const dbUser = await getOrCreateDbUser(request.user);
    const started = Date.now();

    try {
      const result = await wallets.claimDailyCheckin(dbUser.id);
      if (result.configFallback) {
        requestLogger(request.log, 'wallet').sys.warn(
          { event: 'wallet.checkin.config_fallback', userId: dbUser.id },
          'VIP 签到配置不可用，已按默认绝对额发放'
        );
      }
      requestLogger(request.log, 'wallet').biz.info(
        {
          event: 'wallet.checkin.claimed',
          userId: dbUser.id,
          rewardCredits: result.checkin.reward_credits,
          baseRewardCredits: result.checkin.base_reward_credits,
          vipRewardCredits: result.checkin.vip_reward_credits,
          durationMs: Date.now() - started,
        },
        '签到奖励已领取'
      );
      return reply.send(
        ok<PostDailyCheckinData>({
          wallet: toWalletBalance(result.wallet),
          checkin: {
            claimed_at: result.checkin.claimed_at,
            next_claim_at: result.checkin.next_claim_at,
            reward_credits: result.checkin.reward_credits,
            main_reward_credits: result.checkin.main_reward_credits,
            bonus_reward_credits: result.checkin.bonus_reward_credits,
            base_reward_credits: result.checkin.base_reward_credits,
            vip_reward_credits: result.checkin.vip_reward_credits,
          },
        })
      );
    } catch (error) {
      request.log.warn({ err: error, userId: dbUser.id }, 'MiniApp daily check-in failed');
      return reply.status(409).send(fail('CHECKIN_NOT_READY', '签到还未到时间'));
    }
  });
}
