import type { HealthData } from '@miniapp/shared';
import { ok } from '@miniapp/shared';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { startChatHistorySyncJob, stopChatHistorySyncJob } from './features/generation/index.js';
import {
  startImagePlazaGenerationJob,
  stopImagePlazaGenerationJob,
} from './features/image-plaza/job.js';
import { startChatImageGenerationJob, stopChatImageGenerationJob } from './features/image/job.js';
import { shutdownTextPostprocessValidation } from './features/text-postprocess/validate-pool.js';
import { startStoryMemoryJob, stopStoryMemoryJob } from './features/story-memory/worker.js';
import { registerCors } from './lib/cors.js';
import { startEngineeringTelemetry } from './lib/engineering-observability.js';
import {
  startFreeZoneEvaluationJob,
  stopFreeZoneEvaluationJob,
} from './features/free-zone/evaluation-job.js';
import {
  startLobbyRankingRefreshJob,
  stopLobbyRankingRefreshJob,
} from './lib/lobby-ranking-refresh-job.js';
import { fastifyLoggerOptions } from './lib/logger.js';
import { registerRequestPerf, startRuntimeMetrics } from './lib/perf-metrics.js';
import { bindRequestSentryContext } from './lib/sentry.js';
import { config } from './platform/config.js';
import { getMujianOrigin } from './platform/runtime-config.js';
import adminCliSessionRoutes from './routes/admin-cli-session.js';
import adminSupabaseProxyRoutes from './routes/admin-supabase-proxy.js';
import alertRoutes from './routes/alerts.js';
import botRoutes from './routes/bot.js';
import characterSocialRoutes from './routes/character-social.js';
import characterWishRoutes from './routes/character-wishes.js';
import characterRoutes from './routes/characters.js';
import chatFeedbackRoutes from './routes/chat-feedback.js';
import communityRoutes from './routes/community.js';
import conversationRoutes from './routes/conversations.js';
import creatorAnalyticsRoutes from './routes/creator-analytics.js';
import creatorCharacterRoutes from './routes/creator-characters.js';
import creatorToolsRoutes from './routes/creator-tools.js';
import dramaInteractionRoutes from './routes/drama-interactions.js';
import dramaRoutes from './routes/drama.js';
import favoriteRoutes from './routes/favorites.js';
import growthRoutes from './routes/growth.js';
import imagePlazaRoutes from './routes/image-plaza.js';
import imageRoutes from './routes/images.js';
import inviteRoutes from './routes/invite.js';
import lobbyRecommendationRoutes from './routes/lobby-recommendation.js';
import modelsRoutes from './routes/models.js';
import notificationRoutes from './routes/notifications.js';
import paymentRoutes from './routes/payment.js';
import publicCreatorRoutes from './routes/public-creators.js';
import settingsRoutes from './routes/settings.js';
import supportRoutes from './routes/support.js';
import telemetryRoutes from './routes/telemetry.js';
import textPostprocessRoutes from './routes/text-postprocess.js';
import vipRoutes from './routes/vip.js';
import voiceRoutes from './routes/voice.js';
import walletRoutes from './routes/wallet.js';

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
  });
  registerRequestPerf(app);
  await registerCors(app, {
    frontendUrl: config.frontendUrl,
    adminPlatformUrl: config.adminPlatformUrl,
    frontendAllowedOrigins: [...config.frontendAllowedOrigins, getMujianOrigin()],
    development:
      config.nodeEnv !== 'production' ||
      (config.database.target === 'test' && config.devAuthBypass),
  });

  await app.register(characterRoutes);
  await app.register(publicCreatorRoutes);
  await app.register(lobbyRecommendationRoutes);
  await app.register(creatorCharacterRoutes);
  await app.register(characterWishRoutes);
  await app.register(creatorAnalyticsRoutes);
  await app.register(favoriteRoutes);
  await app.register(characterSocialRoutes);
  await app.register(paymentRoutes);
  await app.register(walletRoutes);
  await app.register(vipRoutes);
  await app.register(settingsRoutes);
  await app.register(modelsRoutes);
  await app.register(conversationRoutes);
  await app.register(chatFeedbackRoutes);
  await app.register(voiceRoutes);
  await app.register(imageRoutes);
  await app.register(botRoutes);
  await app.register(growthRoutes);
  await app.register(inviteRoutes);
  await app.register(communityRoutes);
  await app.register(adminSupabaseProxyRoutes);
  await app.register(adminCliSessionRoutes);
  await app.register(notificationRoutes);
  await app.register(supportRoutes);
  await app.register(telemetryRoutes);
  await app.register(alertRoutes);
  await app.register(textPostprocessRoutes);
  await app.register(imagePlazaRoutes);
  await app.register(creatorToolsRoutes);
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
  startStoryMemoryJob(app.log);
  startFreeZoneEvaluationJob(app.log);

  const stopRuntimeMetrics = startRuntimeMetrics();

  app.addHook('onClose', async () => {
    stopRuntimeMetrics();
    stopChatHistorySyncJob();
    stopLobbyRankingRefreshJob();
    stopChatImageGenerationJob();
    stopImagePlazaGenerationJob();
    stopStoryMemoryJob();
    stopFreeZoneEvaluationJob();
    shutdownTextPostprocessValidation();
    await stopEngineeringTelemetry();
  });

  return app;
}
