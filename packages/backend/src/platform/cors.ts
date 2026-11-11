import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { getMujianOrigin } from './runtime-config.js';

export async function registerAppCors(app: FastifyInstance) {
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (
        [config.frontendUrl, config.adminPlatformUrl, getMujianOrigin()].some(
          (allowedOrigin) => allowedOrigin.length > 0 && allowedOrigin === origin
        )
      ) {
        callback(null, true);
        return;
      }

      const isDev = config.nodeEnv !== 'production';

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
    // 取 Chromium 上限 7200s：一轮对话隔十分钟以上再发时不再多一次往返。WebKit 自身上限 600s。
    maxAge: 7200,
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
}
