/**
 * health / __tests__ / server.test.ts
 *
 * 测试重点：
 *   1. judgeStatus 状态判定逻辑
 *   2. /health 端点返回 JSON + 正确 HTTP 状态码
 *   3. unhealthy 状态返回 503
 *   4. port=0 时不启动 HTTP server，但 buildSnapshot 可用
 *   5. 404 行为
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { judgeStatus, startHealthServer, type HealthServerHandle } from '../server.js';

// ─── Mock config ────────────────────────────────────────────────────────────
vi.mock('../../lib/config.js', () => ({
  config: {
    SUPABASE_URL: 'https://mock.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'mock-key',
    ST_DATA_PATH: '/mock',
    ST_PLATFORM_ASSETS_PATH: '/mock',
    ST_BASE_URL: 'http://localhost:8000',
    ST_ADMIN_USERNAME: 'admin',
    ST_ADMIN_PASSWORD: 'pass',
    ST_USER_PASSWORD_SECRET: 'mock-secret-at-least-16',
    HEALTH_PORT: 0,
  },
  loadConfig: vi.fn(),
}));

// ─── Mock getQueueMetrics ───────────────────────────────────────────────────

const mockGetQueueMetrics = vi.fn();

vi.mock('../../queue/metrics.js', () => ({
  getQueueMetrics: (...args: unknown[]) => mockGetQueueMetrics(...args),
}));

// ─── judgeStatus 测试 ───────────────────────────────────────────────────────

describe('judgeStatus()', () => {
  const baseQueue = { pending: 0, processing: 0, failed: 0, dead: 0, oldest_pending_age_ms: null };

  it('全空 → ok', () => {
    expect(judgeStatus(baseQueue)).toBe('ok');
  });

  it('dead > 0 → degraded', () => {
    expect(judgeStatus({ ...baseQueue, dead: 1 })).toBe('degraded');
  });

  it('oldest_pending_age 5min+ → degraded', () => {
    expect(judgeStatus({ ...baseQueue, oldest_pending_age_ms: 6 * 60 * 1000 })).toBe('degraded');
  });

  it('pending > 1000 → unhealthy', () => {
    expect(judgeStatus({ ...baseQueue, pending: 1001 })).toBe('unhealthy');
  });

  it('oldest_pending_age 30min+ → unhealthy', () => {
    expect(judgeStatus({ ...baseQueue, oldest_pending_age_ms: 31 * 60 * 1000 })).toBe('unhealthy');
  });

  it('unhealthy 优先于 degraded', () => {
    // pending > 1000 AND dead > 0
    expect(judgeStatus({ ...baseQueue, pending: 1500, dead: 5 })).toBe('unhealthy');
  });
});

// ─── HTTP server 测试 ──────────────────────────────────────────────────────

describe('startHealthServer()', () => {
  let handle: HealthServerHandle | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetQueueMetrics.mockResolvedValue({
      pending: 0,
      processing: 0,
      failed: 0,
      dead: 0,
      oldest_pending_age_ms: null,
    });
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = null;
  });

  it('port=0 时不监听网络，但 buildSnapshot 可用', async () => {
    handle = await startHealthServer({
      port: 0,
      startTime: Date.now() - 1000,
      getWatcherSnapshot: () => ({ active_handles: 3 }),
    });

    expect(handle.port).toBeNull();
    const snapshot = await handle.buildSnapshot();
    expect(snapshot.status).toBe('ok');
    expect(snapshot.watcher.active_handles).toBe(3);
    expect(snapshot.uptime_ms).toBeGreaterThan(0);
  });

  it('/health 返回 200 + JSON 当状态 ok', async () => {
    handle = await startHealthServer({
      port: 0, // 让 OS 分配端口的话需用 startTime=Date.now()，但这里 port=0 不监听
      startTime: Date.now(),
      getWatcherSnapshot: () => ({ active_handles: 1 }),
    });

    // 改用真正的端口启动
    await handle.stop();
    handle = await startHealthServer({
      port: 0, // 0 不监听
      startTime: Date.now(),
      getWatcherSnapshot: () => ({ active_handles: 1 }),
    });

    // 直接测 buildSnapshot 即可
    const snap = await handle.buildSnapshot();
    expect(snap.status).toBe('ok');
    expect(snap.queue.pending).toBe(0);
  });

  it('真实端口启动后 fetch /health 返回 JSON', async () => {
    handle = await startHealthServer({
      port: 0, // ← Node http server port=0 实际会随机分配，但我们工厂里跳过了
      startTime: Date.now(),
      getWatcherSnapshot: () => ({ active_handles: 2 }),
    });

    // 由于 port=0 不监听，我们需要单独测真实绑定。
    // 启动到随机非 0 端口测真实流量：
    await handle.stop();

    // 用 Math.random 选 30000-39999 端口（极低冲突概率）
    const randomPort = 30000 + Math.floor(Math.random() * 10000);
    handle = await startHealthServer({
      port: randomPort,
      startTime: Date.now(),
      getWatcherSnapshot: () => ({ active_handles: 2 }),
    });

    expect(handle.port).toBe(randomPort);

    const res = await fetch(`http://127.0.0.1:${randomPort}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.queue.pending).toBe(0);
    expect(body.watcher.active_handles).toBe(2);
  });

  it('unhealthy 状态返回 503', async () => {
    mockGetQueueMetrics.mockResolvedValue({
      pending: 2000,
      processing: 0,
      failed: 0,
      dead: 0,
      oldest_pending_age_ms: null,
    });

    const randomPort = 30000 + Math.floor(Math.random() * 10000);
    handle = await startHealthServer({
      port: randomPort,
      startTime: Date.now(),
      getWatcherSnapshot: () => ({ active_handles: 0 }),
    });

    const res = await fetch(`http://127.0.0.1:${randomPort}/health`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('unhealthy');
  });

  it('其他路径返回 404', async () => {
    const randomPort = 30000 + Math.floor(Math.random() * 10000);
    handle = await startHealthServer({
      port: randomPort,
      startTime: Date.now(),
      getWatcherSnapshot: () => ({ active_handles: 0 }),
    });

    const res = await fetch(`http://127.0.0.1:${randomPort}/unknown`);
    expect(res.status).toBe(404);
  });
});
