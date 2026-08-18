/**
 * sync-engine / registry / __tests__ / registry.test.ts
 *
 * 配置清单测试套件：正向（happy path）+ 6 个负向（sad path）。
 * 每个负向 case 对应 validator.ts 中的一条业务规则。
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, RegistryLoadError } from '../loader.js';
import { validate } from '../validator.js';
import type { SyncRegistry, SyncEntry } from '../types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// __tests__/ → ../../../registry.yaml
const REGISTRY_PATH = resolve(__dirname, '../../../registry.yaml');

// ─── 辅助：构造最小合法条目 ────────────────────────────────────────────────────
function makeEntry(overrides: Partial<SyncEntry> = {}): SyncEntry {
  return {
    id: 'test_entry',
    label: '测试条目',
    partition: 'A',
    shape: 'asset',
    direction: 'down',
    st: { type: 'asset_file', directory: 'characters', naming: 'platform_uuid' },
    supabase: { schema: 'miniapp', table: 'characters', column: '*' },
    triggers: ['init'],
    transform: 'passthrough',
    order: 10,
    enabled: true,
    ...overrides,
  };
}

function makeRegistry(entries: SyncEntry[]): SyncRegistry {
  return { version: 1, entries };
}

// ─── 正向测试 ──────────────────────────────────────────────────────────────────
describe('正向：加载真实 registry.yaml', () => {
  it('应成功加载，返回 4 条规则', () => {
    const registry = loadRegistry(REGISTRY_PATH);
    expect(registry.version).toBe(2);
    expect(registry.entries).toHaveLength(4);
  });

  it('应包含预期的 4 个条目 id', () => {
    const registry = loadRegistry(REGISTRY_PATH);
    const ids = registry.entries.map((e) => e.id);
    expect(ids).toContain('platform_characters_down');
    expect(ids).toContain('platform_presets_down');
    expect(ids).toContain('platform_settings_down');
    expect(ids).toContain('user_settings_up');
  });

  it('分区 A 条目应有 3 条，分区 B 应有 1 条', () => {
    const registry = loadRegistry(REGISTRY_PATH);
    const partA = registry.entries.filter((e) => e.partition === 'A');
    const partB = registry.entries.filter((e) => e.partition === 'B');
    expect(partA).toHaveLength(3);
    expect(partB).toHaveLength(1);
  });

  it('资产层条目 order 应全部 < 配置层条目 order', () => {
    const registry = loadRegistry(REGISTRY_PATH);
    const assetOrders = registry.entries
      .filter((e) => e.shape === 'asset' && e.direction === 'down')
      .map((e) => e.order);
    const configOrders = registry.entries
      .filter((e) => e.shape === 'config' && e.direction === 'down')
      .map((e) => e.order);

    const maxAsset = Math.max(...assetOrders);
    const minConfig = Math.min(...configOrders);
    expect(maxAsset).toBeLessThan(minConfig);
  });

  it('所有条目均已启用', () => {
    const registry = loadRegistry(REGISTRY_PATH);
    expect(registry.entries.every((e) => e.enabled)).toBe(true);
  });

  it('通过全部业务规则校验（validate 返回空数组）', () => {
    const registry = loadRegistry(REGISTRY_PATH);
    const errors = validate(registry);
    expect(errors).toHaveLength(0);
  });

  it('user_settings_up 条目应使用哨兵值 order=999', () => {
    const registry = loadRegistry(REGISTRY_PATH);
    const upEntry = registry.entries.find((e) => e.id === 'user_settings_up');
    expect(upEntry?.order).toBe(999);
  });
});

// ─── 负向测试 1：id 重复 ────────────────────────────────────────────────────────
describe('负向 1：duplicate_entry_id', () => {
  it('两条条目 id 相同时应报 duplicate_entry_id', () => {
    const entry1 = makeEntry({ id: 'same_id', partition: 'A', direction: 'down', order: 10 });
    const entry2 = makeEntry({ id: 'same_id', partition: 'A', direction: 'down', order: 20 });
    const registry = makeRegistry([entry1, entry2]);

    const errors = validate(registry);
    expect(errors.some((e) => e.rule === 'duplicate_entry_id')).toBe(true);
    expect(errors.some((e) => e.entryId === 'same_id')).toBe(true);
  });
});

// ─── 负向测试 2：分区-方向不一致 ─────────────────────────────────────────────────
describe('负向 2：partition_direction_mismatch', () => {
  it('分区 A + direction=up 应报 partition_direction_mismatch', () => {
    const entry = makeEntry({
      id: 'bad_a_up',
      partition: 'A',
      direction: 'up', // 错误：A 类应为 down
      order: 10,
    });
    const registry = makeRegistry([entry]);

    const errors = validate(registry);
    expect(errors.some((e) => e.rule === 'partition_direction_mismatch')).toBe(true);
    expect(errors.find((e) => e.rule === 'partition_direction_mismatch')?.entryId).toBe('bad_a_up');
  });

  it('分区 B + direction=down 应报 partition_direction_mismatch', () => {
    const entry = makeEntry({
      id: 'bad_b_down',
      partition: 'B',
      direction: 'down', // 错误：B 类应为 up
      order: 999,
    });
    const registry = makeRegistry([entry]);

    const errors = validate(registry);
    expect(errors.some((e) => e.rule === 'partition_direction_mismatch')).toBe(true);
  });
});

// ─── 负向测试 3：下发顺序约束违反 ───────────────────────────────────────────────
describe('负向 3：order_constraint_violation', () => {
  it('asset+down order(100) >= config+down order(50) 时应报 order_constraint_violation', () => {
    const assetEntry = makeEntry({
      id: 'asset_late',
      shape: 'asset',
      direction: 'down',
      partition: 'A',
      order: 100, // 错误：资产层 order 不能 >= 配置层 order
    });
    const configEntry = makeEntry({
      id: 'config_early',
      shape: 'config',
      direction: 'down',
      partition: 'A',
      st: { type: 'json_field', file: 'settings.json', field_path: '*' },
      order: 50, // 配置层 order 反而更小
    });
    const registry = makeRegistry([assetEntry, configEntry]);

    const errors = validate(registry);
    expect(errors.some((e) => e.rule === 'order_constraint_violation')).toBe(true);
  });

  it('asset+down order(10) < config+down order(100) 时不应报错', () => {
    const assetEntry = makeEntry({
      id: 'asset_ok',
      shape: 'asset',
      direction: 'down',
      partition: 'A',
      order: 10,
    });
    const configEntry = makeEntry({
      id: 'config_ok',
      shape: 'config',
      direction: 'down',
      partition: 'A',
      st: { type: 'json_field', file: 'settings.json', field_path: '*' },
      order: 100,
    });
    const registry = makeRegistry([assetEntry, configEntry]);

    const errors = validate(registry);
    expect(errors.filter((e) => e.rule === 'order_constraint_violation')).toHaveLength(0);
  });
});

// ─── 负向测试 4：ST 路径冲突 ─────────────────────────────────────────────────────
describe('负向 4：st_path_conflict', () => {
  it('两个 down 条目写同一 ST asset_file 目录时应报 st_path_conflict', () => {
    const entry1 = makeEntry({
      id: 'asset_conflict_1',
      partition: 'A',
      direction: 'down',
      shape: 'asset',
      st: { type: 'asset_file', directory: 'characters', naming: 'platform_uuid' },
      order: 10,
    });
    const entry2 = makeEntry({
      id: 'asset_conflict_2',
      partition: 'A',
      direction: 'down',
      shape: 'asset',
      st: { type: 'asset_file', directory: 'characters', naming: 'platform_uuid' }, // 同一路径
      order: 20,
    });
    const registry = makeRegistry([entry1, entry2]);

    const errors = validate(registry);
    expect(errors.some((e) => e.rule === 'st_path_conflict')).toBe(true);
  });

  it('两个 down 条目写同一 json_field 路径时应报 st_path_conflict', () => {
    const entry1 = makeEntry({
      id: 'config_conflict_1',
      partition: 'A',
      direction: 'down',
      shape: 'config',
      st: { type: 'json_field', file: 'settings.json', field_path: '*' },
      order: 100,
    });
    const entry2 = makeEntry({
      id: 'config_conflict_2',
      partition: 'A',
      direction: 'down',
      shape: 'config',
      st: { type: 'json_field', file: 'settings.json', field_path: '*' }, // 同一路径
      order: 110,
    });
    const registry = makeRegistry([entry1, entry2]);

    const errors = validate(registry);
    expect(errors.some((e) => e.rule === 'st_path_conflict')).toBe(true);
  });

  it('不同目录的 asset 条目不应触发路径冲突', () => {
    const entry1 = makeEntry({
      id: 'asset_a',
      partition: 'A',
      direction: 'down',
      shape: 'asset',
      st: { type: 'asset_file', directory: 'characters', naming: 'platform_uuid' },
      order: 10,
    });
    const entry2 = makeEntry({
      id: 'asset_b',
      partition: 'A',
      direction: 'down',
      shape: 'asset',
      st: { type: 'asset_file', directory: 'OpenAI Settings', naming: 'platform_uuid' }, // 不同目录
      order: 20,
      supabase: { schema: 'st', table: 'platform_presets', column: 'preset_payload' },
    });
    const registry = makeRegistry([entry1, entry2]);

    const errors = validate(registry);
    expect(errors.filter((e) => e.rule === 'st_path_conflict')).toHaveLength(0);
  });
});

// ─── 负向测试 5：asset 形态使用非 passthrough transform ────────────────────────
describe('负向 5：invalid_transform_for_shape', () => {
  it('asset 条目使用 character_ref 时应报 invalid_transform_for_shape', () => {
    const entry = makeEntry({
      id: 'asset_bad_transform',
      partition: 'A',
      shape: 'asset',
      direction: 'down',
      transform: 'character_ref', // 错误：asset 只能用 passthrough
      order: 10,
    });
    const registry = makeRegistry([entry]);

    const errors = validate(registry);
    expect(errors.some((e) => e.rule === 'invalid_transform_for_shape')).toBe(true);
    expect(errors.find((e) => e.rule === 'invalid_transform_for_shape')?.entryId).toBe(
      'asset_bad_transform'
    );
  });

  it('config 条目使用 character_ref 时不应触发 invalid_transform_for_shape', () => {
    const entry = makeEntry({
      id: 'config_character_ref',
      partition: 'A',
      shape: 'config',
      direction: 'down',
      st: { type: 'json_field', file: 'settings.json', field_path: 'active_character' },
      transform: 'character_ref', // config + json_field 使用 character_ref 是合法的
      order: 100,
    });
    const registry = makeRegistry([entry]);

    const errors = validate(registry);
    expect(errors.filter((e) => e.rule === 'invalid_transform_for_shape')).toHaveLength(0);
  });
});

// ─── 负向测试 6：上行条目哨兵值违反 ─────────────────────────────────────────────
describe('负向 6：up_order_sentinel_violation', () => {
  it('direction=up 且 order < 900 时应报 up_order_sentinel_violation', () => {
    const entry = makeEntry({
      id: 'up_bad_order',
      partition: 'B',
      direction: 'up',
      shape: 'config',
      st: { type: 'json_field', file: 'settings.json', field_path: '*' },
      triggers: ['watch'],
      order: 50, // 错误：上行条目应 >= 900
    });
    const registry = makeRegistry([entry]);

    const errors = validate(registry);
    expect(errors.some((e) => e.rule === 'up_order_sentinel_violation')).toBe(true);
    expect(errors.find((e) => e.rule === 'up_order_sentinel_violation')?.entryId).toBe(
      'up_bad_order'
    );
  });

  it('direction=up 且 order=999 时不应触发 up_order_sentinel_violation', () => {
    const entry = makeEntry({
      id: 'up_ok_order',
      partition: 'B',
      direction: 'up',
      shape: 'config',
      st: { type: 'json_field', file: 'settings.json', field_path: '*' },
      triggers: ['watch'],
      order: 999, // 正确的哨兵值
    });
    const registry = makeRegistry([entry]);

    const errors = validate(registry);
    expect(errors.filter((e) => e.rule === 'up_order_sentinel_violation')).toHaveLength(0);
  });
});

// ─── 负向测试 7：加载不存在的文件 ────────────────────────────────────────────────
describe('负向 7：loader 错误处理', () => {
  it('文件不存在时应抛出 RegistryLoadError', () => {
    expect(() => loadRegistry('/nonexistent/path/registry.yaml')).toThrow(RegistryLoadError);
  });

  it('RegistryLoadError 错误信息应包含文件路径', () => {
    const badPath = '/nonexistent/path/registry.yaml';
    try {
      loadRegistry(badPath);
      expect.fail('应该抛出错误');
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryLoadError);
      expect((err as RegistryLoadError).message).toContain(resolve(badPath));
    }
  });
});
