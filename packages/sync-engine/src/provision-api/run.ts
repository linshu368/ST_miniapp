/**
 * sync-engine / provision-api / run.ts
 *
 * Provision API 服务的 CLI 入口。
 * 独立于 watcher 进程启动，可以单独运行：pnpm start:provision
 */

import { loadConfig, config } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { startProvisionApi } from './server.js';

const logger = createLogger('provision-api:run');

async function main() {
  logger.info('🌉 ST_miniapp Provision API 服务启动中...');

  loadConfig();

  const handle = await startProvisionApi({ port: config.PROVISION_API_PORT });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, '收到退出信号，准备退出');
    await handle.stop();
    logger.info('Provision API 已安全退出');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info({ port: handle.port }, '✅ Provision API 服务已就绪');
}

main().catch((err) => {
  console.error('Provision API 启动失败:', err);
  process.exit(1);
});
