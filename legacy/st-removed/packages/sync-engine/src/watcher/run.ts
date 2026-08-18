/**
 * sync-engine / watcher / run.ts
 *
 * CLI 入口脚本。
 * 用法：cd packages/sync-engine && pnpm watch
 */

import 'dotenv/config';
import { startWatcher } from './index.js';

startWatcher().catch((err) => {
  console.error(`\n❌ Watcher 启动失败：${err}`);
  process.exit(1);
});
