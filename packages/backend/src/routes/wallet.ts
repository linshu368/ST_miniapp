import { FastifyInstance } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import type {
  GetDailyCheckinData,
  GetCharacterFreeQuotaData,
  GetWalletBalanceData,
  GetWalletSpendingData,
  PostDailyCheckinData,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import {
  MiniappWalletRepository,
  toWalletBalance,
} from '../infrastructure/repositories/MiniappWalletRepository.js';
import { MiniappCharacterFreeQuotaRepository } from '../infrastructure/repositories/MiniappCharacterFreeQuotaRepository.js';
import { CHARACTER_FREE_CHAT_QUOTA_LIMIT } from '../features/billing/free-quota.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function walletRoutes(app: FastifyInstance) {
  const wallets = new MiniappWalletRepository();
  const freeQuotas = new MiniappCharacterFreeQuotaRepository();

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
  app.get(
    '/api/wallet/free-quota/:characterId',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { characterId } = request.params as { characterId?: string };
      if (!characterId || !UUID_PATTERN.test(characterId)) {
        return reply.status(400).send(fail('INVALID_CHARACTER', '角色卡 ID 无效'));
      }
      const dbUser = await getOrCreateDbUser(request.user);
      const status = await freeQuotas.getStatus(
        dbUser.id,
        characterId,
        CHARACTER_FREE_CHAT_QUOTA_LIMIT
      );
      return reply.send(
        ok<GetCharacterFreeQuotaData>({
          character_id: characterId,
          quota_limit: CHARACTER_FREE_CHAT_QUOTA_LIMIT,
          used_rounds: status.usedRounds,
          remaining_rounds: status.remainingRounds,
          exhausted: status.exhausted,
        })
      );
    }
  );

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
