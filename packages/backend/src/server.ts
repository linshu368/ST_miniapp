import './instrumentation.js';

import * as Sentry from '@sentry/node';
import { buildApp } from './app.js';
import { config } from './platform/config.js';
import { logger } from './lib/logger.js';
import {
  startCurrentPostprocessVersionRefresh,
  warmCurrentPostprocessVersion,
} from './features/text-postprocess/config.js';

async function main() {
  const app = await buildApp();

  // 预热发生在接流量前；失败会在模块内静默降级，不能阻止聊天服务启动。
  await warmCurrentPostprocessVersion();
  startCurrentPostprocessVersionRefresh();

  await app.listen({
    port: config.port,
    host: '::', // 同时接受 IPv6 和 IPv4
  });

  app.log.info({ port: config.port }, 'Backend running');

  // Graceful shutdown: close Fastify (stop accepting + drain in-flight) then exit 0 on stop signals.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, async () => {
      await app.close();
      await Sentry.flush(2_000);
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  Sentry.captureException(err);
  void Sentry.flush(2_000).finally(() => process.exit(1));
});
