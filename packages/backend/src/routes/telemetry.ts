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
  DRAMA_TIMING_BODY_LIMIT,
  DramaTimingReportSchema,
  dramaTimingLogFields,
  type PostDramaTimingData,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUserRecord } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';
import {
  DramaTimingBusyError,
  DramaTimingRepository,
} from '../features/drama/timing-repository.js';
import { getDramaTimingPersistenceConfig } from '../platform/runtime-config.js';

export default async function telemetryRoutes(app: FastifyInstance) {
  const wallets = new MiniappWalletRepository();
  const timingRepository = new DramaTimingRepository();
  const timingConfig = getDramaTimingPersistenceConfig();

  // 仅保护本进程的诊断日志容量，不作为业务限流或跨副本一致性机制。
  const uploadWindows = new Map<number, { startedAt: number; count: number }>();
  let totalWindow = { startedAt: performance.now(), count: 0 };
  const windowMs = 60_000;

  // @frontend-ready: true — 保留 Railway 诊断；显式启用后写分析表，不参与视频播放。
  app.post(
    '/api/telemetry/drama-timing',
    {
      preHandler: [requireTelegramAuth],
      bodyLimit: DRAMA_TIMING_BODY_LIMIT,
    },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const now = performance.now();
      if (now - totalWindow.startedAt >= windowMs) totalWindow = { startedAt: now, count: 0 };
      // 无论输入是否合法都计入预算，避免重复坏包刷校验或日志。
      if (uploadWindows.size >= 2000) {
        for (const [key, value] of uploadWindows) {
          if (now - value.startedAt >= windowMs) uploadWindows.delete(key);
        }
      }
      const userId = request.user.id;
      let userWindow = uploadWindows.get(userId);
      if (!userWindow || now - userWindow.startedAt >= windowMs) {
        userWindow = { startedAt: now, count: 0 };
      }
      if (
        totalWindow.count >= 1000 ||
        userWindow.count >= 120 ||
        (!uploadWindows.has(userId) && uploadWindows.size >= 2000)
      ) {
        reply.header('Retry-After', '60');
        return reply.status(429).send(fail('RATE_LIMITED', 'Timing upload limit exceeded'));
      }
      totalWindow.count += 1;
      userWindow.count += 1;
      uploadWindows.set(userId, userWindow);

      const parsed = DramaTimingReportSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.status(400).send(fail('BAD_REQUEST', 'Invalid timing report'));
      const log = requestLogger(request.log, 'drama');
      const fields = { ...dramaTimingLogFields(parsed.data), upload_request_id: request.id };
      try {
        if (parsed.data.phase === 'slow') log.biz.warn(fields, 'drama frontend timing');
        else log.biz.info(fields, 'drama frontend timing');
      } catch (err) {
        log.sys.error(
          { err, event: 'drama.timing_log_failed', observation_id: parsed.data.id },
          'drama frontend timing log failed'
        );
        return reply.status(503).send(fail('INTERNAL_ERROR', 'Timing log unavailable'));
      }
      if (timingConfig.enabled && parsed.data.type === 'playback') {
        const started = performance.now();
        try {
          const result = await timingRepository.persist(parsed.data, timingConfig);
          log.biz.info(
            {
              event: 'drama.timing_persisted',
              observation_id: parsed.data.id,
              phase: parsed.data.phase,
              result,
              elapsed_ms: performance.now() - started,
              environment: timingConfig.environment,
              server_release: timingConfig.release,
            },
            'drama timing persisted'
          );
          return reply.send(ok<PostDramaTimingData>({ accepted: true, persisted: true }));
        } catch (err) {
          const busy = err instanceof DramaTimingBusyError;
          log.sys.error(
            {
              err,
              event: 'drama.timing_persist_failed',
              observation_id: parsed.data.id,
              elapsed_ms: performance.now() - started,
            },
            'drama timing persistence failed'
          );
          if (busy) reply.header('Retry-After', '5');
          return reply
            .status(busy ? 429 : 503)
            .send(fail(busy ? 'RATE_LIMITED' : 'INTERNAL_ERROR', 'Timing persistence unavailable'));
        }
      }
      return reply.send(ok<PostDramaTimingData>({ accepted: true }));
    }
  );

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
        const dbUser = await getOrCreateDbUserRecord(request.user);
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
