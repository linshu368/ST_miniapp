/**
 * sync-engine / bridge-api / run.ts
 *
 * Bridge API 服务的 CLI 入口。
 * 独立于 watcher 进程启动，可以单独运行：pnpm bridge-api
 */

import { loadConfig, config } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { startBridgeApi } from './server.js';

const logger = createLogger('bridge-api:run');

async function main() {
  logger.info('🌉 ST_miniapp Bridge API 服务启动中...');

  loadConfig();

  const handle = await startBridgeApi({ port: config.BRIDGE_API_PORT });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, '收到退出信号，准备退出');
    await handle.stop();
    logger.info('Bridge API 已安全退出');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info({ port: handle.port }, '✅ Bridge API 服务已就绪');
}

main().catch((err) => {
  console.error('Bridge API 启动失败:', err);
  process.exit(1);
});
