/**
 * sync-engine / watcher / index.ts
 *
 * 反向同步进程主编排。
 * D6 改造：onChange 从直调 uploadSettings 改为入队消费模式。
 * D7 改造：集成结构化日志 + 健康监控 HTTP 端点。
 *
 * 启动流程：
 *   1. loadConfig()                      → 环境变量校验
 *   2. loadRegistry() + validate()       → 清单加载 + 校验
 *   3. extractWatchUpEntries()           → 提取上行规则
 *   4. listHandles()                     → 扫描 tg_* 目录
 *   5. 批量查询 users 表                 → 构建 handle→userId 映射
 *   6. 启动 consumer                     → 先扫残留任务 + 兜底轮询
 *   7. 启动 health server                → /health 端点
 *   8. startWatching(handles, onChange)  → 启动文件监听（入队 + nudge）
 *   9. 注册 SIGTERM/SIGINT              → 优雅退出
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, config } from '../lib/config.js';
import { getSupabaseClient } from '../lib/supabase.js';
import { listHandles } from '../lib/st-fs.js';
import { createLogger } from '../lib/logger.js';
import { loadRegistry } from '../registry/loader.js';
import { validate } from '../registry/validator.js';
import { extractWatchUpEntries, matchEntry } from './matcher.js';
import { startWatching } from './file-watcher.js';
import { enqueue } from '../queue/producer.js';
import { Consumer } from '../queue/consumer.js';
import { startHealthServer } from '../health/server.js';

const logger = createLogger('watcher');

// ─── 清单路径 ────────────────────────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REGISTRY_PATH = resolve(__dirname, '../../registry.yaml');

// ─── 主启动函数 ────────────────────────────────────────────────────────────────

export async function startWatcher(): Promise<void> {
  const startTime = Date.now();

  logger.info('👀 ST_miniapp 同步引擎 — 反向同步 Watcher');

  // ── 1. 环境变量校验 ───────────────────────────────────────────────────────
  logger.info('步骤 1/8：加载环境变量');
  loadConfig();

  // ── 2. 清单加载 + 校验 ────────────────────────────────────────────────────
  logger.info('步骤 2/8：加载配置清单');
  const registry = loadRegistry(REGISTRY_PATH);
  const errors = validate(registry);
  if (errors.length > 0) {
    logger.error({ errorCount: errors.length }, '清单校验失败');
    for (const err of errors) {
      logger.error({ entryId: err.entryId, rule: err.rule }, err.message);
    }
    throw new Error('配置清单校验失败，watcher 无法启动');
  }
  logger.info({ version: registry.version, ruleCount: registry.entries.length }, '清单加载成功');

  // ── 3. 提取上行规则 ───────────────────────────────────────────────────────
  logger.info('步骤 3/8：提取上行监听规则');
  const upEntries = extractWatchUpEntries(registry);
  if (upEntries.length === 0) {
    logger.warn('无可用的上行 watch 规则，watcher 无事可做');
    return;
  }
  logger.info({ count: upEntries.length, ids: upEntries.map((e) => e.id) }, '找到上行规则');

  // ── 4. 扫描 handle 目录 ──────────────────────────────────────────────────
  logger.info('步骤 4/8：扫描用户目录');
  const handles = listHandles();
  if (handles.length === 0) {
    logger.warn('未发现任何 tg_* 用户目录，watcher 将等待用户初始化后重启');
    return;
  }
  logger.info({ count: handles.length }, '发现用户目录');

  // ── 5. 构建 handle→userId 映射 ───────────────────────────────────────────
  logger.info('步骤 5/8：构建 handle→userId 映射');
  const handleToUser = await buildHandleUserMap(handles);
  const unmapped = handles.filter((h) => !handleToUser.has(h));
  logger.info({ mapped: handleToUser.size }, '映射构建完成');
  if (unmapped.length > 0) {
    logger.warn({ unmapped }, 'handle 在 users 表中未找到，将跳过监听');
  }

  const watchableHandles = handles.filter((h) => handleToUser.has(h));
  if (watchableHandles.length === 0) {
    logger.warn('无可监听的用户，watcher 退出');
    return;
  }

  // ── 6. 启动 consumer ─────────────────────────────────────────────────────
  logger.info('步骤 6/8：启动任务消费器');
  const consumer = new Consumer();
  await consumer.start();

  // ── 7. 启动 health server ────────────────────────────────────────────────
  logger.info('步骤 7/8：启动健康监控');
  const healthHandle = await startHealthServer({
    port: config.HEALTH_PORT,
    startTime,
    getWatcherSnapshot: () => ({
      active_handles: watchableHandles.length,
    }),
  });

  // ── 8. 启动文件监听（入队模式） ───────────────────────────────────────────
  logger.info('步骤 8/8：启动文件监听');

  const watcherHandle = startWatching(watchableHandles, async (handle, filePath) => {
    const matched = matchEntry(upEntries, handle, filePath);
    if (!matched) {
      logger.debug({ handle }, '文件变更未匹配任何上行规则，忽略');
      return;
    }

    const userId = handleToUser.get(handle);
    if (!userId) return;

    logger.info({ handle, ruleId: matched.id }, '触发上行同步');

    try {
      const result = await enqueue({ userId, handle });
      if (result.enqueued) {
        consumer.nudge();
      }
    } catch (err) {
      logger.error({ handle, err: String(err) }, '入队失败');
    }
  });

  // ── 优雅退出 ─────────────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, '收到退出信号，准备退出');
    await watcherHandle.stop();
    await consumer.stop();
    await healthHandle.stop();
    logger.info('已安全退出');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('✅ Watcher 已启动（队列模式），等待文件变更');
}

// ─── 辅助：批量查 handle → userId 映射 ───────────────────────────────────────

async function buildHandleUserMap(handles: string[]): Promise<Map<string, string>> {
  const db = getSupabaseClient();
  const map = new Map<string, string>();

  const { data, error } = await db
    .schema('miniapp')
    .from('users')
    .select('id, st_handle')
    .in('st_handle', handles);

  if (error) {
    throw new Error(`查询 users 表失败：${error.message}`);
  }

  for (const row of data ?? []) {
    const r = row as { id: string; st_handle: string };
    if (r.st_handle) {
      map.set(r.st_handle, r.id);
    }
  }

  return map;
}
