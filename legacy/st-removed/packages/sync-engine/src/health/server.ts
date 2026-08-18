/**
 * sync-engine / health / server.ts
 *
 * 最小 HTTP server，零额外依赖（Node 原生 http 模块）。
 * 单 /health 端点，返回 JSON 健康快照。
 *
 * 绑定策略：仅 127.0.0.1（本机访问）。
 *   阶段一同步引擎与 Bridge 同机部署，外部不需直连。
 *   云上若需要远程访问，由反向代理/sidecar 暴露。
 *
 * 状态判定：
 *   ok        — 队列健康（dead=0 且 oldest_pending_age < 5min）
 *   degraded  — 有死信，或 oldest_pending_age > 5min
 *   unhealthy — pending > 1000，或 oldest_pending_age > 30min
 */

import { createServer, type Server } from 'node:http';
import { createLogger } from '../lib/logger.js';
import { getQueueMetrics, type QueueMetrics } from '../queue/metrics.js';

const logger = createLogger('health');

const BIND_HOST = '127.0.0.1';

const DEGRADED_OLDEST_PENDING_MS = 5 * 60 * 1000;
const UNHEALTHY_PENDING_THRESHOLD = 1000;
const UNHEALTHY_OLDEST_PENDING_MS = 30 * 60 * 1000;

// ─── 数据类型 ────────────────────────────────────────────────────────────────

export type HealthStatus = 'ok' | 'degraded' | 'unhealthy';

export interface WatcherSnapshot {
  active_handles: number;
}

export interface HealthSnapshot {
  status: HealthStatus;
  uptime_ms: number;
  queue: QueueMetrics;
  watcher: WatcherSnapshot;
}

export interface HealthServerOptions {
  /** 监听端口（0 表示不启动） */
  port: number;
  /** 提供 watcher 实时快照（active_handles 等） */
  getWatcherSnapshot: () => WatcherSnapshot;
  /** 进程启动时间，用于计算 uptime_ms */
  startTime: number;
}

export interface HealthServerHandle {
  stop: () => Promise<void>;
  /** 测试用：手动构造一次快照 */
  buildSnapshot: () => Promise<HealthSnapshot>;
  /** 实际绑定端口（端口 0 自动分配时可读取） */
  port: number | null;
}

// ─── 状态判定 ────────────────────────────────────────────────────────────────

export function judgeStatus(queue: QueueMetrics): HealthStatus {
  if (queue.pending > UNHEALTHY_PENDING_THRESHOLD) return 'unhealthy';
  if (
    queue.oldest_pending_age_ms !== null &&
    queue.oldest_pending_age_ms > UNHEALTHY_OLDEST_PENDING_MS
  ) {
    return 'unhealthy';
  }
  if (queue.dead > 0) return 'degraded';
  if (
    queue.oldest_pending_age_ms !== null &&
    queue.oldest_pending_age_ms > DEGRADED_OLDEST_PENDING_MS
  ) {
    return 'degraded';
  }
  return 'ok';
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

/**
 * 启动健康监控 HTTP server。
 * port=0 时直接返回禁用句柄，不启动。
 */
export async function startHealthServer(opts: HealthServerOptions): Promise<HealthServerHandle> {
  const { port, getWatcherSnapshot, startTime } = opts;

  async function buildSnapshot(): Promise<HealthSnapshot> {
    const queue = await getQueueMetrics();
    return {
      status: judgeStatus(queue),
      uptime_ms: Date.now() - startTime,
      queue,
      watcher: getWatcherSnapshot(),
    };
  }

  if (port === 0) {
    logger.info('HEALTH_PORT=0，跳过启动 health server');
    return {
      stop: async () => {},
      buildSnapshot,
      port: null,
    };
  }

  const server: Server = createServer(async (req, res) => {
    // 只接受 /health GET
    if (req.method !== 'GET' || req.url !== '/health') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    try {
      const snapshot = await buildSnapshot();
      // status 转 HTTP code：ok=200, degraded=200（仍可服务）, unhealthy=503
      res.statusCode = snapshot.status === 'unhealthy' ? 503 : 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(snapshot, null, 2));
    } catch (err) {
      logger.sys.error({ event: 'health.snapshot.failed', err }, '构建快照失败');
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  logger.info({ host: BIND_HOST, port: actualPort }, 'health server 已启动');

  return {
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else {
            logger.info('health server 已停止');
            resolve();
          }
        });
      }),
    buildSnapshot,
    port: actualPort,
  };
}
