import { FastifyInstance } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import type { GetWalletBalanceData } from '@miniapp/shared';
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
}
