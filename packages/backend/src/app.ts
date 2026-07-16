import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './platform/config.js';
import { ok } from '@miniapp/shared';
import type { HealthData } from '@miniapp/shared';
import characterRoutes from './routes/characters.js';
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
import botRoutes from './routes/bot.js';
import growthRoutes from './routes/growth.js';
import debugRoutes from './routes/debug.js'; // [iframe-timing] TEMP DEBUG

import { startChatHistorySyncJob, stopChatHistorySyncJob } from './lib/chat-history-sync-job.js';

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if ([config.frontendUrl, config.csPlatformUrl].includes(origin)) {
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
      'X-CS-Admin-Token',
      'X-CS-Operator-Id',
      'X-Bot-Internal-Secret',
    ],
  });

  await app.register(characterRoutes);
  await app.register(bridgeRoutes);
  await app.register(paymentRoutes);
  await app.register(walletRoutes);
  await app.register(settingsRoutes);
  await app.register(wishRoutes);
  await app.register(csPlatformRoutes);
  await app.register(modelsRoutes);
  await app.register(llmProxyRoutes);
  await app.register(chatsRoutes);
  await app.register(botRoutes);
  await app.register(growthRoutes);
  await app.register(debugRoutes); // [iframe-timing] TEMP DEBUG

  app.addContentTypeParser(
    ['application/octet-stream', 'multipart/form-data'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  );
  app.all('/api/bridge/st/*', stProxyHandler);

  app.get('/health', async () => {
    return ok<HealthData>({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  // 启动后台定时同步任务
  startChatHistorySyncJob(app.log);

  app.addHook('onClose', async () => {
    stopChatHistorySyncJob();
  });

  return app;
}
