import { FastifyInstance } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import type {
  GetDailyCheckinData,
  GetWalletBalanceData,
  PostDailyCheckinData,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import {
  MiniappWalletRepository,
  toWalletBalance,
} from '../infrastructure/repositories/MiniappWalletRepository.js';

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
  app.get('/api/wallet/checkin', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const dbUser = await getOrCreateDbUser(request.user);
    const checkin = await wallets.getDailyCheckinStatus(dbUser.id);

    return reply.send(ok<GetDailyCheckinData>({ checkin }));
  });

  // @frontend-ready: true
  app.post('/api/wallet/checkin', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const dbUser = await getOrCreateDbUser(request.user);

    try {
      const result = await wallets.claimDailyCheckin(dbUser.id);
      return reply.send(
        ok<PostDailyCheckinData>({
          wallet: toWalletBalance(result.wallet),
          checkin: {
            claimed_at: result.checkin.claimed_at,
            next_claim_at: result.checkin.next_claim_at,
            reward_credits: result.checkin.reward_credits,
          },
        })
      );
    } catch (error) {
      request.log.warn({ err: error, userId: dbUser.id }, 'MiniApp daily check-in failed');
      return reply.status(409).send(fail('CHECKIN_NOT_READY', '签到还未到时间'));
    }
  });
}
