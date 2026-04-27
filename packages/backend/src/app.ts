import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './platform/config.js';
import { ok } from '@miniapp/shared';
import type { HealthData } from '@miniapp/shared';
import characterRoutes from './routes/characters.js';
import sessionRoutes from './routes/sessions.js';

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
  await app.register(sessionRoutes);

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
