/**
 * watcher / __tests__ / uploader.test.ts
 *
 * 对 uploadSettings() 的单元测试，vi.mock 隔离外部依赖。
 *
 * 测试重点：
 *   1. 正常路径：白名单过滤 + hash 计算 + INSERT 成功
 *   2. 幂等去重：hash 相同时跳过写入
 *   3. 白名单子集为空时跳过
 *   4. UNIQUE 冲突（23505）视为幂等成功
 *   5. platform_settings 拉取失败时抛 UploadError
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';

// ─── Mock fs（用 memfs 模拟文件系统） ────────────────────────────────────────
vi.mock('node:fs', async () => {
  const memfs = await import('memfs');
  return { ...memfs.fs, default: memfs.fs };
});

// ─── Mock config ────────────────────────────────────────────────────────────
vi.mock('../../lib/config.js', () => ({
  config: {
    ST_DATA_PATH: '/mock-st-data',
    SUPABASE_URL: 'https://mock.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'mock-key',
    ST_BASE_URL: 'http://localhost:8000',
    ST_ADMIN_USERNAME: 'admin',
    ST_ADMIN_PASSWORD: 'pass',
    ST_USER_PASSWORD_SECRET: 'mock-secret-at-least-16',
  },
  loadConfig: vi.fn(),
}));

// ─── Mock Supabase 客户端 ───────────────────────────────────────────────────
// 需要精细 mock 各个查询链

const mockInsert = vi.fn();
const mockSelectPlatform = vi.fn();
const mockSelectLatest = vi.fn();
const mockSelectMaxRev = vi.fn();

function createMockFrom(_table: string) {
  return {
    select: vi.fn().mockImplementation((cols: string) => {
      if (cols.includes('platform_version') && cols.includes('writable_paths')) {
        return mockSelectPlatform();
      }
      if (cols === 'content_hash') {
        return mockSelectLatest();
      }
      if (cols === 'user_revision') {
        return mockSelectMaxRev();
      }
      return {
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        single: vi.fn(),
        maybeSingle: vi.fn(),
      };
    }),
    insert: mockInsert,
  };
}

const mockSchema = vi.fn().mockReturnValue({
  from: vi.fn().mockImplementation(createMockFrom),
});

vi.mock('../../lib/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({
    schema: mockSchema,
  })),
}));

// ─── 在 mock 之后 import ───────────────────────────────────────────────────
import { uploadSettings, UploadError } from '../uploader.js';
import { computeContentHash } from '../../lib/hash.js';

// ─── 测试固件 ──────────────────────────────────────────────────────────────
const HANDLE = 'tg_12345678';
const USER_ID = 'user-0000-0000-0000-000000000001';

const MOCK_SETTINGS = {
  active_character: 'platform_aaa.png',
  theme: 'dark',
  oai_settings: { prompts: [{ role: 'system', content: 'hello' }] },
  some_locked_field: 'should_be_filtered',
};

const MOCK_WRITABLE_PATHS = [{ path: 'active_character', transform: 'character_ref' }];

function setupSettingsFile() {
  vol.reset();
  vol.mkdirSync('/mock-st-data/tg_12345678', { recursive: true });
  vol.writeFileSync(
    '/mock-st-data/tg_12345678/settings.json',
    JSON.stringify(MOCK_SETTINGS, null, 2)
  );
}

/** 构造标准的 chain mock 返回值 */
function chainResult(data: unknown, error: unknown = null) {
  return {
    order: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data, error }),
        maybeSingle: vi.fn().mockResolvedValue({ data, error }),
      }),
    }),
    eq: vi.fn().mockReturnValue({
      order: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data, error }),
        }),
      }),
    }),
  };
}

// ─── 测试套件 ──────────────────────────────────────────────────────────────
describe('uploadSettings()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSettingsFile();

    // 默认 mock：platform_settings 返回白名单
    mockSelectPlatform.mockReturnValue(
      chainResult({ platform_version: 1, writable_paths: MOCK_WRITABLE_PATHS })
    );

    // 默认 mock：无历史行（新用户）
    mockSelectLatest.mockReturnValue(chainResult(null));
    mockSelectMaxRev.mockReturnValue(chainResult(null));

    // 默认 mock：INSERT 成功
    mockInsert.mockResolvedValue({ error: null });
  });

  // ── 场景 1：正常路径 ──────────────────────────────────────────────────
  it('新用户正常路径：INSERT 成功，返回 revision=1', async () => {
    const result = await uploadSettings(USER_ID, HANDLE);

    expect(result.skipped).toBe(false);
    expect(result.revision).toBe(1);
    expect(result.contentHash).toBeTruthy();
    expect(mockInsert).toHaveBeenCalledOnce();

    // 验证写入的 settings_jsonb 只含白名单字段
    const insertArg = mockInsert.mock.calls[0]![0] as Record<string, unknown>;
    const settingsWritten = insertArg.settings_jsonb as Record<string, unknown>;
    expect(settingsWritten).toHaveProperty('active_character');
    expect(settingsWritten).not.toHaveProperty('theme');
    expect(settingsWritten).not.toHaveProperty('some_locked_field');
  });

  it('正常路径：content_hash 应等于白名单子集的 canonical hash', async () => {
    const { pick } = await import('lodash-es');
    const subset = pick(MOCK_SETTINGS, ['active_character']);
    const expectedHash = computeContentHash(subset as Record<string, unknown>);

    const result = await uploadSettings(USER_ID, HANDLE);
    expect(result.contentHash).toBe(expectedHash);
  });

  // ── 场景 2：幂等去重 ──────────────────────────────────────────────────
  it('hash 相同时跳过写入，skipped=true', async () => {
    const { pick } = await import('lodash-es');
    const subset = pick(MOCK_SETTINGS, ['active_character']);
    const existingHash = computeContentHash(subset as Record<string, unknown>);

    mockSelectLatest.mockReturnValue(chainResult({ content_hash: existingHash }));

    const result = await uploadSettings(USER_ID, HANDLE);

    expect(result.skipped).toBe(true);
    expect(result.revision).toBeNull();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  // ── 场景 3：白名单子集为空 ─────────────────────────────────────────────
  it('白名单子集为空时跳过', async () => {
    // settings.json 中没有白名单内的任何字段
    vol.writeFileSync(
      '/mock-st-data/tg_12345678/settings.json',
      JSON.stringify({ only_locked: 'value' })
    );

    const result = await uploadSettings(USER_ID, HANDLE);

    expect(result.skipped).toBe(true);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('历史白名单包含预设字段时，不得将其写入用户设置', async () => {
    mockSelectPlatform.mockReturnValue(
      chainResult({
        platform_version: 1,
        writable_paths: [
          ...MOCK_WRITABLE_PATHS,
          { path: 'oai_settings.prompts', transform: 'passthrough' },
        ],
      })
    );

    await uploadSettings(USER_ID, HANDLE);

    const insertArg = mockInsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertArg.settings_jsonb).toEqual({
      active_character: 'platform_aaa.png',
    });
  });

  // ── 场景 4：UNIQUE 冲突视为幂等成功 ────────────────────────────────────
  it('INSERT 时 UNIQUE 冲突（23505）视为幂等成功', async () => {
    mockInsert.mockResolvedValue({ error: { code: '23505', message: 'duplicate' } });

    const result = await uploadSettings(USER_ID, HANDLE);

    expect(result.skipped).toBe(true);
  });

  // ── 场景 5：platform_settings 拉取失败 ─────────────────────────────────
  it('platform_settings 拉取失败时抛 UploadError', async () => {
    mockSelectPlatform.mockReturnValue(chainResult(null, { message: 'table not found' }));

    await expect(uploadSettings(USER_ID, HANDLE)).rejects.toThrow(UploadError);
  });

  // ── 场景 6：settings.json 不存在时抛 UploadError ──────────────────────
  it('settings.json 不存在时抛 UploadError', async () => {
    vol.unlinkSync('/mock-st-data/tg_12345678/settings.json');

    await expect(uploadSettings(USER_ID, HANDLE)).rejects.toThrow(UploadError);
  });
});
