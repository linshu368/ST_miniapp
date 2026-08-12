import Fastify, { type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { config } from './platform/config.js';
import { fastifyLoggerOptions } from './lib/logger.js';
import { ok } from '@miniapp/shared';
import type { HealthData } from '@miniapp/shared';
import characterRoutes from './routes/characters.js';
import favoriteRoutes from './routes/favorites.js';
import bridgeRoutes from './routes/bridge.js';
import paymentRoutes from './routes/payment.js';
import walletRoutes from './routes/wallet.js';
import settingsRoutes from './routes/settings.js';
import wishRoutes from './routes/wishes.js';
import csPlatformRoutes from './routes/cs-platform.js';
import modelsRoutes from './routes/models.js';
import { stProxyHandler } from './middleware/stProxy.js';
import llmProxyRoutes from './routes/llm-proxy.js';
import chatsRoutes from './routes/chats.js';
import conversationRoutes from './routes/conversations.js';
import chatEngineRoutes from './routes/chat-engine.js';
import botRoutes from './routes/bot.js';
import growthRoutes from './routes/growth.js';
import debugRoutes from './routes/debug.js'; // [iframe-timing] TEMP DEBUG
import adminSupabaseProxyRoutes from './routes/admin-supabase-proxy.js';
import simulationRoutes from './routes/simulation.js';
import notificationRoutes from './routes/notifications.js';
import supportRoutes from './routes/support.js';
import { startChatHistorySyncJob, stopChatHistorySyncJob } from './lib/chat-history-sync-job.js';
import {
  startLobbyRankingRefreshJob,
  stopLobbyRankingRefreshJob,
} from './lib/lobby-ranking-refresh-job.js';
import { bindRequestSentryContext } from './lib/sentry.js';

export async function buildApp() {
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

  app.addHook('onRequest', async (request) => {
    bindRequestSentryContext(request);
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if ([config.frontendUrl, config.csPlatformUrl, config.adminPlatformUrl].includes(origin)) {
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
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Init-Data',
      'X-Request-Id',
      'X-First-Chat-Journey-Id',
      'X-First-Chat-Attempt-Id',
      'X-Boot-Session-Id',
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
  await app.register(bridgeRoutes);
  await app.register(paymentRoutes);
  await app.register(walletRoutes);
  await app.register(settingsRoutes);
  await app.register(wishRoutes);
  await app.register(csPlatformRoutes);
  await app.register(modelsRoutes);
  await app.register(llmProxyRoutes);
  await app.register(chatsRoutes);
  await app.register(conversationRoutes);
  await app.register(chatEngineRoutes);
  await app.register(botRoutes);
  await app.register(growthRoutes);
  await app.register(debugRoutes); // [iframe-timing] TEMP DEBUG
  await app.register(adminSupabaseProxyRoutes);
  await app.register(simulationRoutes);
  await app.register(notificationRoutes);
  await app.register(supportRoutes);

  app.addContentTypeParser(
    ['application/octet-stream', 'multipart/form-data'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  );
  // @frontend-ready: true
  app.all('/api/bridge/st/*', stProxyHandler);

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

  app.addHook('onClose', async () => {
    stopChatHistorySyncJob();
    stopLobbyRankingRefreshJob();
  });

  return app;
}
