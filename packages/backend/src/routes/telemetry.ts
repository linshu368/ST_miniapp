/**
 * backend / routes / telemetry.ts
 *
 * GET /api/telemetry/replay-context — 聊天回放用的最小只读用户标签。
 */
import type { FastifyInstance } from 'fastify';
import {
  fail,
  GetReplayContextQuerySchema,
  ok,
  parseGetReplayContextData,
  type GetReplayContextData,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';

export default async function telemetryRoutes(app: FastifyInstance) {
  const wallets = new MiniappWalletRepository();

  // @frontend-ready: true
  app.get(
    '/api/telemetry/replay-context',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const query = GetReplayContextQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send(fail('BAD_REQUEST', 'Invalid query'));
      }

      const log = requestLogger(request.log, 'telemetry');
      const startedAt = Date.now();
      try {
        const dbUser = await getOrCreateDbUser(request.user);
        const isPaidUser = await wallets.hasCompletedPayment(dbUser.id);
        const data = parseGetReplayContextData({
          telegram_user_id: String(request.user.id),
          is_paid_user: isPaidUser,
          total_chat_rounds: toTotalChatRounds(dbUser.total_round),
        });

        log.biz.info(
          {
            event: 'telemetry.replay_context.read',
            isPaidUser: data.is_paid_user,
            totalChatRounds: data.total_chat_rounds,
            durationMs: Date.now() - startedAt,
          },
          'replay context 已读取'
        );

        return reply.send(ok<GetReplayContextData>(data));
      } catch (err) {
        log.sys.error(
          { event: 'telemetry.replay_context.failed', err, durationMs: Date.now() - startedAt },
          'replay context 读取失败'
        );
        return reply.status(500).send(fail('INTERNAL_ERROR', 'replay context 读取失败'));
      }
    }
  );
}

function toTotalChatRounds(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}
