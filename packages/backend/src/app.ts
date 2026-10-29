import Fastify, { type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { config } from './platform/config.js';
import { fastifyLoggerOptions } from './lib/logger.js';
import { ok } from '@miniapp/shared';
import type { HealthData } from '@miniapp/shared';
import characterRoutes from './routes/characters.js';
import favoriteRoutes from './routes/favorites.js';
import characterSocialRoutes from './routes/character-social.js';
import paymentRoutes from './routes/payment.js';
import walletRoutes from './routes/wallet.js';
import vipRoutes from './routes/vip.js';
import settingsRoutes from './routes/settings.js';
import modelsRoutes from './routes/models.js';
import conversationRoutes from './routes/conversations.js';
import voiceRoutes from './routes/voice.js';
import imageRoutes from './routes/images.js';
import botRoutes from './routes/bot.js';
import growthRoutes from './routes/growth.js';
import inviteRoutes from './routes/invite.js';
import communityRoutes from './routes/community.js';
import adminSupabaseProxyRoutes from './routes/admin-supabase-proxy.js';
import notificationRoutes from './routes/notifications.js';
import supportRoutes from './routes/support.js';
import telemetryRoutes from './routes/telemetry.js';
import alertRoutes from './routes/alerts.js';
import textPostprocessRoutes from './routes/text-postprocess.js';
import imagePlazaRoutes from './routes/image-plaza.js';
import dramaRoutes from './routes/drama.js';
import dramaInteractionRoutes from './routes/drama-interactions.js';
import { shutdownTextPostprocessValidation } from './features/text-postprocess/validate-pool.js';
import { startChatHistorySyncJob, stopChatHistorySyncJob } from './features/generation/index.js';
import { startChatImageGenerationJob, stopChatImageGenerationJob } from './features/image/job.js';
import {
  startImagePlazaGenerationJob,
  stopImagePlazaGenerationJob,
} from './features/image-plaza/job.js';
import {
  startVideoPlazaGenerationJob,
  stopVideoPlazaGenerationJob,
} from './features/image-plaza/video-job.js';
import { initializeVideoMedia } from './features/image-plaza/video-media.js';
import {
  startLobbyRankingRefreshJob,
  stopLobbyRankingRefreshJob,
} from './lib/lobby-ranking-refresh-job.js';
import { bindRequestSentryContext } from './lib/sentry.js';
import { registerRequestPerf, startRuntimeMetrics } from './lib/perf-metrics.js';
import { startEngineeringTelemetry } from './lib/engineering-observability.js';

export async function buildApp() {
  const stopEngineeringTelemetry = startEngineeringTelemetry(config.engineeringTelemetry);
  const app = Fastify({
    logger: fastifyLoggerOptions() as unknown as FastifyServerOptions['logger'],
    // 跨边界链路追踪：优先复用入站 X-Request-Id，否则生成。见 docs/日志系统.md §6
    genReqId(req) {
      const hdr = req.headers['x-request-id'];
      if (typeof hdr === 'string' && hdr.length > 0) return hdr;
      if (Array.isArray(hdr) && hdr[0]) return hdr[0];
      return randomUUID();
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    bindRequestSentryContext(request);
    // 让前端 http.client span 能拿到 DNS/连接/首字节拆分，用来区分慢在网络还是后端。
    // 该头只允许单个 origin，所以只对配置的前端域名开放。
    if (config.frontendUrl) reply.header('Timing-Allow-Origin', config.frontendUrl);
  });
  registerRequestPerf(app);

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (
        [config.frontendUrl, config.adminPlatformUrl].some(
          (allowedOrigin) => allowedOrigin.length > 0 && allowedOrigin === origin
        )
      ) {
        callback(null, true);
        return;
      }

      const isDev = config.nodeEnv !== 'production' || process.env.DEV_AUTH_BYPASS === '1';

      if (isDev) {
        if (origin.endsWith('.vercel.app')) {
          callback(null, true);
          return;
        }

        if (origin.startsWith('http://localhost:')) {
          callback(null, true);
          return;
        }
      }

      app.log.warn(`CORS rejected origin: ${origin}`);
      callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    // 前端(Vercel)到后端(Railway)是跨源请求，且带自定义头 X-Init-Data 必触发预检。
    // 不设置时浏览器默认仅缓存 5s，导致几乎每个 API 请求前都多一次 OPTIONS 往返。
    // 取 600s：Chromium 对 Max-Age 的上限就是 7200s，600s 在改 CORS 配置后仍能较快生效。
    maxAge: 600,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Init-Data',
      'X-Request-Id',
      'sentry-trace',
      'baggage',
      'X-CS-Admin-Token',
      'X-CS-Operator-Id',
      'X-Bot-Internal-Secret',
      'apikey',
      'accept-profile',
      'content-profile',
      'prefer',
      'range',
      'x-client-info',
      'x-supabase-api-version',
    ],
    exposedHeaders: ['content-range', 'range-unit', 'x-supabase-api-version'],
  });

  await app.register(characterRoutes);
  await app.register(favoriteRoutes);
  await app.register(characterSocialRoutes);
  await app.register(paymentRoutes);
  await app.register(walletRoutes);
  await app.register(vipRoutes);
  await app.register(settingsRoutes);
  await app.register(modelsRoutes);
  await app.register(conversationRoutes);
  await app.register(voiceRoutes);
  await app.register(imageRoutes);
  await app.register(botRoutes);
  await app.register(growthRoutes);
  await app.register(inviteRoutes);
  await app.register(communityRoutes);
  await app.register(adminSupabaseProxyRoutes);
  await app.register(notificationRoutes);
  await app.register(supportRoutes);
  await app.register(telemetryRoutes);
  await app.register(alertRoutes);
  await app.register(textPostprocessRoutes);
  await app.register(imagePlazaRoutes);
  await app.register(dramaRoutes);
  await app.register(dramaInteractionRoutes);

  app.addContentTypeParser(
    ['application/octet-stream', 'multipart/form-data'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  );

  // @frontend-ready: true
  app.get('/health', async () => {
    return ok<HealthData>({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  if (config.chatHistorySyncEnabled) {
    app.log.info('[sync-job] Chat history sync job enabled');
    startChatHistorySyncJob(app.log);
  } else {
    app.log.info('[sync-job] Chat history sync job disabled by CHAT_HISTORY_SYNC_ENABLED=false');
  }

  if (config.lobbyRankingRefreshEnabled) {
    startLobbyRankingRefreshJob(app.log);
  } else {
    app.log.info('[lobby-ranking] refresh job disabled by LOBBY_RANKING_REFRESH_ENABLED=false');
  }

  startChatImageGenerationJob(app.log);
  startImagePlazaGenerationJob(app.log);
  await initializeVideoMedia(app.log);
  startVideoPlazaGenerationJob(app.log);

  const stopRuntimeMetrics = startRuntimeMetrics();

  app.addHook('onClose', async () => {
    stopRuntimeMetrics();
    stopChatHistorySyncJob();
    stopLobbyRankingRefreshJob();
    stopChatImageGenerationJob();
    stopImagePlazaGenerationJob();
    stopVideoPlazaGenerationJob();
    shutdownTextPostprocessValidation();
    await stopEngineeringTelemetry();
  });

  return app;
}
