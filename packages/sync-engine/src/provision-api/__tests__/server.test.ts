/**
 * provision-api / __tests__ / server.test.ts
 *
 * 路由分发回归测试（针对 iframe 耗时优化 #3 的改动）：
 *   异步端点 POST /provision/:userId 的正则从 [^/]+ 改为 [^/?]+ 以支持 query
 *   （?cards=none&force=）。本测试锁死：
 *     1. 异步端点解析 cards/force 正确传给 provision，且立即 202；
 *     2. 关键回归点：/provision/:id/sync 与 /provision/:id/character/:id/sync
 *        不被异步正则「吞掉」，仍分别路由到 sync / ensureCharacter 分支。
 *
 * 用真实 HTTP server（随机端口）+ mock provisioner，无需任何环境变量。
 * 参考 health/__tests__/server.test.ts 的既有模式。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock provisioner（避免真实 Supabase/ST 依赖，只验路由分发与参数）──────────
const mockProvision = vi.fn();
const mockEnsureCharacter = vi.fn();

vi.mock('../../provisioner/index.js', () => ({
  provision: (...args: unknown[]) => mockProvision(...args),
  ensureCharacterProvisioned: (...args: unknown[]) => mockEnsureCharacter(...args),
}));

// config 用 lazy Proxy，import 不触发校验；此处仍 mock 以彻底隔离环境变量。
vi.mock('../../lib/config.js', () => ({
  config: {},
  loadConfig: vi.fn(),
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { startProvisionApi, type ProvisionApiHandle } from '../server.js';

describe('provision-api 路由分发', () => {
  let handle: ProvisionApiHandle | null = null;
  let base = '';

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProvision.mockResolvedValue({
      userId: 'u',
      stHandle: 'tg_x',
      charactersWritten: 0,
      presetsWritten: 0,
      hadInvalidRef: false,
    });
    mockEnsureCharacter.mockResolvedValue({ stHandle: 'tg_x', status: 'skipped' });

    const port = 30000 + Math.floor(Math.random() * 10000);
    handle = await startProvisionApi({ port });
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = null;
  });

  it('POST /provision/:id?cards=none → 202，且 provision 收到 characterScope=none, force=false', async () => {
    const res = await fetch(`${base}/provision/user-1?cards=none`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('accepted');

    // 异步端点：provision 在 202 返回后触发，等它被调用
    await vi.waitFor(() => expect(mockProvision).toHaveBeenCalledTimes(1));
    const [userId, opts] = mockProvision.mock.calls[0] as [string, Record<string, unknown>];
    expect(userId).toBe('user-1');
    expect(opts.characterScope).toBe('none');
    expect(opts.force).toBe(false);
    expect(mockEnsureCharacter).not.toHaveBeenCalled();
  });

  it('POST /provision/:id?force=true → 202，且 provision 收到 force=true, characterScope=all(默认)', async () => {
    const res = await fetch(`${base}/provision/user-2?force=true`, { method: 'POST' });
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(mockProvision).toHaveBeenCalledTimes(1));
    const [, opts] = mockProvision.mock.calls[0] as [string, Record<string, unknown>];
    expect(opts.force).toBe(true);
    expect(opts.characterScope).toBe('all');
  });

  it('POST /provision/:id（无 query）→ 202，characterScope=all, force=false', async () => {
    const res = await fetch(`${base}/provision/user-3`, { method: 'POST' });
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(mockProvision).toHaveBeenCalledTimes(1));
    const [userId, opts] = mockProvision.mock.calls[0] as [string, Record<string, unknown>];
    expect(userId).toBe('user-3');
    expect(opts.characterScope).toBe('all');
    expect(opts.force).toBe(false);
  });

  it('回归点：POST /provision/:id/sync?cards=none → 200，走 sync 分支（await provision），未被异步正则吞掉', async () => {
    const res = await fetch(`${base}/provision/user-4/sync?cards=none`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');

    expect(mockProvision).toHaveBeenCalledTimes(1);
    const [userId, opts] = mockProvision.mock.calls[0] as [string, Record<string, unknown>];
    expect(userId).toBe('user-4');
    expect(opts.characterScope).toBe('none');
  });

  it('回归点：POST /provision/:id/character/:cid/sync → 200，走 ensureCharacter 分支', async () => {
    const res = await fetch(`${base}/provision/user-5/character/abc-123/sync`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('skipped');

    expect(mockEnsureCharacter).toHaveBeenCalledTimes(1);
    const [userId, characterId] = mockEnsureCharacter.mock.calls[0] as [string, string];
    expect(userId).toBe('user-5');
    expect(characterId).toBe('abc-123');
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('GET /health → 200', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  it('未知路由 → 404', async () => {
    const res = await fetch(`${base}/nope`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
