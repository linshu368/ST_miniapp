/**
 * backend / routes / telemetry.ts
 *
 * POST /api/telemetry/drama-timing — 短剧启动/播放计时报告，写日志与 Loki 诊断。
 */
import type { FastifyInstance } from 'fastify';
import {
  fail,
  ok,
  DRAMA_TIMING_BODY_LIMIT,
  DramaTimingReportSchema,
  dramaTimingLogFields,
  type PostDramaTimingData,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { requestLogger } from '../lib/logger.js';
import { getDramaTimingLogContext } from '../platform/runtime-config.js';
import { dramaExperimentLogUser } from '../features/drama/delivery.js';
import { observeDramaStartupDiagnostic } from '../lib/engineering-observability.js';

export default async function telemetryRoutes(app: FastifyInstance) {
  const timingConfig = getDramaTimingLogContext();
  // 仅保护本进程的诊断日志容量，不作为业务限流或跨副本一致性机制。
  const uploadWindows = new Map<number, { startedAt: number; count: number }>();
  let totalWindow = { startedAt: performance.now(), count: 0 };
  const windowMs = 60_000;

  // @frontend-ready: true — 慢启动详情复用 Cloud Loki 出口；不写 Supabase 分析表。
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
      const fields = {
        ...dramaTimingLogFields(parsed.data),
        upload_request_id: request.id,
        environment: timingConfig.environment,
        server_release: timingConfig.release,
        ...dramaExperimentLogUser(userId),
      };
      try {
        if (parsed.data.phase === 'slow') log.biz.warn(fields, 'drama frontend timing');
        else log.biz.info(fields, 'drama frontend timing');
      } catch (err) {
        log.sys.error(
          { err, event: 'drama.timing_log_failed', observation_id: parsed.data.id },
          'drama frontend timing log failed'
        );
      }
      observeDramaStartupDiagnostic(parsed.data);
      return reply.status(202).send(ok<PostDramaTimingData>({ accepted: true }));
    }
  );
}
