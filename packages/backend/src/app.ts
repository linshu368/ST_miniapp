import type { HealthData } from '@miniapp/shared';
import { ok } from '@miniapp/shared';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { startCallCostJob, stopCallCostJob } from './features/generation/call-costs.js';
import {
  startFreeZoneEvaluationJob,
  stopFreeZoneEvaluationJob,
} from './features/free-zone/evaluation-job.js';
import { startChatHistorySyncJob, stopChatHistorySyncJob } from './features/generation/index.js';
import {
  startImagePlazaGenerationJob,
  stopImagePlazaGenerationJob,
} from './features/image-plaza/job.js';
import {
  startVideoPlazaGenerationJob,
  stopVideoPlazaGenerationJob,
} from './features/image-plaza/video-job.js';
import { startStoryMemoryJob, stopStoryMemoryJob } from './features/story-memory/worker.js';
import { shutdownTextPostprocessValidation } from './features/text-postprocess/validate-pool.js';
import { registerCors } from './lib/cors.js';
import adminModelProviderRoutes from './routes/admin-model-providers.js';
import { startEngineeringTelemetry } from './lib/engineering-observability.js';
import {
  startLobbyRankingRefreshJob,
  stopLobbyRankingRefreshJob,
} from './lib/lobby-ranking-refresh-job.js';
import { fastifyLoggerOptions } from './lib/logger.js';
import { registerRequestPerf, startRuntimeMetrics } from './lib/perf-metrics.js';
import { bindRequestSentryContext } from './lib/sentry.js';
import { config } from './platform/config.js';
import { startLogAlerts } from './platform/observability/alert-runtime.js';
import { requestId } from './platform/observability/context.js';
import { registerHttpObservation } from './platform/observability/http.js';
import { observation } from './platform/observability/runtime.js';
import { getMujianOrigin, isDramaEnabled } from './platform/runtime-config.js';
import adminCliSessionRoutes from './routes/admin-cli-session.js';
import adminFreeZoneRoutes from './routes/admin-free-zone.js';
import adminStatusBarRoutes from './routes/admin-status-bar.js';
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
import dramaSurveyRoutes from './routes/drama-survey.js';
import dramaRoutes from './routes/drama.js';
import favoriteRoutes from './routes/favorites.js';
import characterPersonaRoutes from './routes/character-persona.js';
import statusBarRoutes from './routes/status-bar.js';
import creatorStatusBarRoutes from './routes/creator-status-bar.js';
import growthRoutes from './routes/growth.js';
import growthPromptRoutes from './routes/growth-prompts.js';
import imagePlazaRoutes from './routes/image-plaza.js';
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
  const stopLogAlerts = startLogAlerts();
  const stopEngineeringTelemetry = startEngineeringTelemetry(config.engineeringTelemetry);
  const app = Fastify({
    logger: fastifyLoggerOptions() as unknown as FastifyServerOptions['logger'],
    disableRequestLogging: true,
    // Accept only a bounded correlation ID; it never authorizes or deduplicates a request.
    genReqId(req) {
      return requestId(req.headers['x-request-id']);
    },
  });

  registerHttpObservation(app, observation);
  app.addHook('onRequest', async (request) => {
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

  await registerApplicationRoutes(app);

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

  startImagePlazaGenerationJob(app.log);
  startVideoPlazaGenerationJob(app.log);
  startStoryMemoryJob(app.log);
  startFreeZoneEvaluationJob(app.log);
  startCallCostJob(app.log);

  const stopRuntimeMetrics = startRuntimeMetrics();

  app.addHook('onClose', async () => {
    stopRuntimeMetrics();
    stopChatHistorySyncJob();
    stopLobbyRankingRefreshJob();
    stopImagePlazaGenerationJob();
    await stopVideoPlazaGenerationJob();
    stopStoryMemoryJob();
    stopFreeZoneEvaluationJob();
    stopCallCostJob();
    shutdownTextPostprocessValidation();
    await stopEngineeringTelemetry();
    await stopLogAlerts();
  });

  return app;
}

async function registerApplicationRoutes(app: Awaited<ReturnType<typeof Fastify>>) {
  await app.register(characterRoutes);
  await app.register(publicCreatorRoutes);
  await app.register(lobbyRecommendationRoutes);
  await app.register(creatorCharacterRoutes);
  await app.register(characterWishRoutes);
  await app.register(creatorAnalyticsRoutes);
  await app.register(favoriteRoutes);
  await app.register(characterPersonaRoutes);
  await app.register(statusBarRoutes);
  await app.register(creatorStatusBarRoutes);
  await app.register(characterSocialRoutes);
  await app.register(paymentRoutes);
  await app.register(walletRoutes);
  await app.register(vipRoutes);
  await app.register(settingsRoutes);
  await app.register(modelsRoutes);
  await app.register(adminModelProviderRoutes);
  await app.register(conversationRoutes);
  await app.register(chatFeedbackRoutes);
  await app.register(voiceRoutes);
  await app.register(botRoutes);
  await app.register(growthRoutes);
  await app.register(growthPromptRoutes);
  await app.register(inviteRoutes);
  await app.register(communityRoutes);
  await app.register(adminSupabaseProxyRoutes);
  await app.register(adminFreeZoneRoutes);
  await app.register(adminStatusBarRoutes);
  await app.register(adminCliSessionRoutes);
  await app.register(notificationRoutes);
  await app.register(supportRoutes);
  await app.register(alertRoutes);
  await app.register(textPostprocessRoutes);
  await app.register(imagePlazaRoutes);
  await app.register(creatorToolsRoutes);
  // 短剧整体下线（前端只剩「开发中」占位页）：路由不注册则旧客户端得到 404，不会碰 Stream/DB。
  // 默认关闭，恢复时在 Railway 设 DRAMA_ENABLED=true 并重启即可。telemetry 目前只有短剧计时一个端点，随开关一起注册。
  if (isDramaEnabled()) {
    await app.register(dramaSurveyRoutes);
    await app.register(telemetryRoutes);
    await app.register(dramaRoutes);
    await app.register(dramaInteractionRoutes);
  }
}
