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
import { stProxyHandler } from './middleware/stProxy.js';
import llmProxyRoutes from './routes/llm-proxy.js';
import chatsRoutes from './routes/chats.js';

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  // ── 插件注册 ──
  await app.register(cors, {
    origin: (origin, callback) => {
      // 无 origin 的请求（curl、服务端调用）直接放行
      if (!origin) {
        callback(null, true);
        return;
      }

      // 精确匹配配置的前端域名 (Prod & Dev)
      if (origin === config.frontendUrl) {
        callback(null, true);
        return;
      }

      // 判断是否是开发或测试环境
      const isDev = config.nodeEnv !== 'production' || process.env.DEV_AUTH_BYPASS === '1';

      if (isDev) {
        // 开发环境：所有 vercel.app 子域名放行（含 preview URL）
        if (origin.endsWith('.vercel.app')) {
          callback(null, true);
          return;
        }

        // 开发环境：本地开发端口放行
        if (origin.startsWith('http://localhost:')) {
          callback(null, true);
          return;
        }
      }

      // 其他来源拒绝
      app.log.warn(`CORS rejected origin: ${origin}`);
      callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Init-Data'],
  });

  // ── 路由挂载 ──
  await app.register(characterRoutes);
  await app.register(bridgeRoutes);
  await app.register(paymentRoutes);
  await app.register(walletRoutes);
  await app.register(settingsRoutes);
  await app.register(wishRoutes);
  await app.register(llmProxyRoutes);
  await app.register(chatsRoutes);

  // ── ST 反向代理：/api/bridge/st/* → ST 原生服务 ──
  // 注意：使用 addContentTypeParser 允许透传任意 Content-Type 的 raw body
  app.addContentTypeParser(
    ['application/octet-stream', 'multipart/form-data'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  );
  app.all('/api/bridge/st/*', stProxyHandler);

  // ── 健康检查 ──
  // @frontend-ready: true
  app.get('/health', async () => {
    return ok<HealthData>({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
