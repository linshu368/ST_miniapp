import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './platform/config.js';
import { ok } from '@miniapp/shared';
import type { HealthData } from '@miniapp/shared';

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  // ── 插件注册 ──
  await app.register(cors, {
    origin: [
      config.frontendUrl,
      // Vercel preview URL 的模式：*.vercel.app
      /\.vercel\.app$/,
    ],
    credentials: true,
  });

  // ── 健康检查（框架验证用）──
  app.get('/health', async () => {
    return ok<HealthData>({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  // ── 后续业务路由在这里挂载 ──
  // await app.register(characterRoutes, { prefix: '/api' });

  return app;
}