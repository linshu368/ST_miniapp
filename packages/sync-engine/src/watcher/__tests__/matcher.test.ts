/**
 * watcher / __tests__ / matcher.test.ts
 *
 * 对 extractWatchUpEntries() 和 matchEntry() 的单元测试。
 *
 * 测试重点：
 *   1. extractWatchUpEntries 只返回 direction=up + enabled + trigger=watch
 *   2. matchEntry 对 json_field 类型正确匹配 st.file
 *   3. matchEntry 对 asset_file 类型正确匹配 st.directory
 *   4. matchEntry 无匹配时返回 null
 *   5. 真实 registry.yaml 中 user_settings_up 能正确匹配 settings.json
 */

import { describe, it, expect, vi } from 'vitest';
import { extractWatchUpEntries, matchEntry } from '../matcher.js';
import type { SyncEntry, SyncRegistry } from '../../registry/types.js';

// ─── Mock config（matchEntry 内部调用 handleDir 需要） ───────────────────────
vi.mock('../../lib/config.js', () => ({
  config: {
    ST_DATA_PATH: '/mock-st-data',
    ST_PLATFORM_ASSETS_PATH: '/mock-assets',
    SUPABASE_URL: 'https://mock.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'mock-key',
    ST_BASE_URL: 'http://localhost:8000',
    ST_ADMIN_USERNAME: 'admin',
    ST_ADMIN_PASSWORD: 'pass',
    ST_USER_PASSWORD_SECRET: 'mock-secret-at-least-16',
  },
  loadConfig: vi.fn(),
}));

// ─── 辅助：构造测试条目 ──────────────────────────────────────────────────────

function makeUpEntry(overrides: Partial<SyncEntry> = {}): SyncEntry {
  return {
    id: 'test_up',
    label: '测试上行条目',
    partition: 'B',
    shape: 'config',
    direction: 'up',
    st: { type: 'json_field', file: 'settings.json', field_path: '*' },
    supabase: { schema: 'st', table: 'user_st_settings', column: 'settings_jsonb' },
    triggers: ['watch'],
    transform: 'passthrough',
    order: 999,
    enabled: true,
    ...overrides,
  };
}

function makeDownEntry(overrides: Partial<SyncEntry> = {}): SyncEntry {
  return {
    id: 'test_down',
    label: '测试下行条目',
    partition: 'A',
    shape: 'asset',
    direction: 'down',
    st: { type: 'asset_file', directory: 'characters', naming: 'platform_uuid' },
    supabase: { schema: 'miniapp', table: 'characters', column: '*' },
    triggers: ['init', 'session_start'],
    transform: 'passthrough',
    order: 10,
    enabled: true,
    ...overrides,
  };
}

function makeRegistry(entries: SyncEntry[]): SyncRegistry {
  return { version: 1, entries };
}

// ─── extractWatchUpEntries 测试 ──────────────────────────────────────────────

describe('extractWatchUpEntries()', () => {
  it('只返回 direction=up + enabled + trigger 含 watch 的条目', () => {
    const registry = makeRegistry([
      makeUpEntry({ id: 'up_watch' }),
      makeDownEntry({ id: 'down_init' }),
      makeUpEntry({ id: 'up_disabled', enabled: false }),
      makeUpEntry({ id: 'up_no_watch', triggers: ['init'] }),
    ]);

    const result = extractWatchUpEntries(registry);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('up_watch');
  });

  it('空清单返回空数组', () => {
    const registry = makeRegistry([]);
    expect(extractWatchUpEntries(registry)).toHaveLength(0);
  });

  it('全是下行条目时返回空数组', () => {
    const registry = makeRegistry([makeDownEntry({ id: 'a' }), makeDownEntry({ id: 'b' })]);
    expect(extractWatchUpEntries(registry)).toHaveLength(0);
  });
});

// ─── matchEntry 测试 ─────────────────────────────────────────────────────────

describe('matchEntry()', () => {
  const handle = 'tg_12345678';

  it('json_field 类型：settings.json 变更应匹配 st.file=settings.json 的规则', () => {
    const entry = makeUpEntry({ id: 'settings_up' });
    const result = matchEntry([entry], handle, '/mock-st-data/tg_12345678/settings.json');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('settings_up');
  });

  it('json_field 类型：其他文件不匹配', () => {
    const entry = makeUpEntry({ id: 'settings_up' });
    const result = matchEntry([entry], handle, '/mock-st-data/tg_12345678/other.json');

    expect(result).toBeNull();
  });

  it('asset_file 类型：characters 目录下的文件应匹配 st.directory=characters', () => {
    const entry = makeUpEntry({
      id: 'chars_up',
      st: { type: 'asset_file', directory: 'characters', naming: 'platform_uuid' },
    });
    const result = matchEntry([entry], handle, '/mock-st-data/tg_12345678/characters/some.png');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('chars_up');
  });

  it('asset_file 类型：其他目录下的文件不匹配', () => {
    const entry = makeUpEntry({
      id: 'chars_up',
      st: { type: 'asset_file', directory: 'characters', naming: 'platform_uuid' },
    });
    const result = matchEntry([entry], handle, '/mock-st-data/tg_12345678/worlds/some.json');

    expect(result).toBeNull();
  });

  it('多条规则时返回第一个匹配的', () => {
    const entries = [
      makeUpEntry({
        id: 'rule_a',
        st: { type: 'json_field', file: 'other.json', field_path: '*' },
      }),
      makeUpEntry({
        id: 'rule_b',
        st: { type: 'json_field', file: 'settings.json', field_path: '*' },
      }),
    ];
    const result = matchEntry(entries, handle, '/mock-st-data/tg_12345678/settings.json');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('rule_b');
  });

  it('无规则时返回 null', () => {
    const result = matchEntry([], handle, '/mock-st-data/tg_12345678/settings.json');
    expect(result).toBeNull();
  });
});
