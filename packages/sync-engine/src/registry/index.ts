/**
 * sync-engine / registry / index.ts
 *
 * CLI 验收入口。
 * 用法：cd packages/sync-engine && pnpm registry
 *
 * 里程碑 A 检查点：执行此命令应输出：
 *   ✅ 清单 v1 加载成功，共 4 条规则
 *   + 4 行摘要表格
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, RegistryLoadError } from './loader.js';
import { validate } from './validator.js';
import type { SyncEntry } from './types.js';

// ─── 找到 registry.yaml 的位置（相对于包根目录） ──────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url));
// src/registry/index.ts → ../../registry.yaml
const REGISTRY_PATH = resolve(__dirname, '../../registry.yaml');

// ─── 主流程 ────────────────────────────────────────────────────────────────────
function main() {
  console.log(`\n📋 ST_miniapp 同步引擎 — 配置清单加载器`);
  console.log(`   文件：${REGISTRY_PATH}\n`);

  // 1. 加载并做结构型校验
  let registry;
  try {
    registry = loadRegistry(REGISTRY_PATH);
  } catch (err) {
    if (err instanceof RegistryLoadError) {
      console.error(`❌ 加载失败：${err.message}`);
    } else {
      console.error(`❌ 未知错误：${err}`);
    }
    process.exit(1);
  }

  // 2. 业务规则校验
  const errors = validate(registry);
  if (errors.length > 0) {
    console.error(`❌ 清单校验失败，共 ${errors.length} 个问题：\n`);
    for (const err of errors) {
      console.error(`  [${err.entryId}] <${err.rule}>`);
      console.error(`    ${err.message}\n`);
    }
    process.exit(1);
  }

  // 3. 输出摘要
  const enabledCount = registry.entries.filter((e) => e.enabled).length;
  console.log(
    `✅ 清单 v${registry.version} 加载成功，共 ${registry.entries.length} 条规则` +
      (enabledCount < registry.entries.length
        ? `（${enabledCount} 条已启用，${registry.entries.length - enabledCount} 条已禁用）`
        : '')
  );
  console.log();

  // 4. 打印摘要表格（按 order 排序）
  const sorted = [...registry.entries].sort((a, b) => a.order - b.order);
  printTable(sorted);

  // 5. 分区分组统计
  console.log();
  const partitionA = registry.entries.filter((e) => e.partition === 'A');
  const partitionB = registry.entries.filter((e) => e.partition === 'B');
  console.log(`📊 分区统计：`);
  console.log(`   分区 A（平台管控 → ST）：${partitionA.length} 条`);
  console.log(`   分区 B（ST → Supabase）：${partitionB.length} 条`);
  console.log();
}

// ─── 格式化摘要表格 ────────────────────────────────────────────────────────────
function printTable(entries: SyncEntry[]) {
  // 构建表格行数据
  const rows = entries.map((e) => ({
    id: e.id,
    分区: e.partition,
    形态: e.shape,
    方向: e.direction === 'down' ? '⬇ down' : '⬆ up',
    触发: e.triggers.join('+'),
    transform: e.transform,
    order: String(e.order),
    启用: e.enabled ? '✓' : '✗',
  }));

  // 计算每列最大宽度
  type ColKey = keyof (typeof rows)[0];
  const cols: ColKey[] = ['id', '分区', '形态', '方向', '触发', 'transform', 'order', '启用'];
  const colWidths: Record<ColKey, number> = {} as Record<ColKey, number>;
  for (const col of cols) {
    colWidths[col] = Math.max(col.length, ...rows.map((r) => r[col].length));
  }

  // 打印表头
  const header = cols.map((c) => c.padEnd(colWidths[c])).join('  ');
  const divider = cols.map((c) => '─'.repeat(colWidths[c])).join('  ');
  console.log(`  ${header}`);
  console.log(`  ${divider}`);

  // 打印每行
  for (const row of rows) {
    const line = cols.map((c) => row[c].padEnd(colWidths[c])).join('  ');
    console.log(`  ${line}`);
  }
}

main();
