/**
 * sync-engine / registry / validator.ts
 *
 * 业务规则校验器。
 * 职责：对已通过 Zod 结构型校验的 SyncRegistry 做跨条目的业务规则检查。
 *
 * 与 schema.ts 的分工：
 *   schema.ts  → 结构型：字段存在 / 类型正确 / 枚举值合法（单条目）
 *   validator.ts → 业务型：分区-方向一致性 / 顺序约束 / 路径冲突等（跨条目）
 */

import type { SyncEntry, SyncRegistry } from './types.js';

// ─── 校验错误类型 ──────────────────────────────────────────────────────────────
export interface ValidationError {
  /** 错误来源的条目 id；跨条目冲突时可能包含多个 id */
  entryId: string;
  /** 机器可读的规则标识，用于测试断言 */
  rule: ValidationRule;
  /** 人读的错误描述 */
  message: string;
}

/** 所有业务规则的标识枚举，与测试中的断言一一对应 */
export type ValidationRule =
  | 'duplicate_entry_id' // id 重复
  | 'partition_direction_mismatch' // 分区与方向不一致（A≠down 或 B≠up）
  | 'order_constraint_violation' // 下发顺序违反（asset order >= config order）
  | 'st_path_conflict' // 同一 ST 路径被多个下行条目写入
  | 'invalid_transform_for_shape' // asset 形态条目使用了非 passthrough 的 transform
  | 'up_order_sentinel_violation'; // 上行条目的 order 未使用哨兵值（< 900）

// ─── 主校验函数 ────────────────────────────────────────────────────────────────
/**
 * 对 SyncRegistry 执行所有业务规则校验。
 *
 * @returns 校验错误列表。空列表表示校验通过。
 *          调用方决定是否将错误视为致命（throw）或仅警告（warn）。
 */
export function validate(registry: SyncRegistry): ValidationError[] {
  const errors: ValidationError[] = [];

  errors.push(...checkDuplicateIds(registry.entries));
  errors.push(...checkPartitionDirectionMismatch(registry.entries));
  errors.push(...checkOrderConstraint(registry.entries));
  errors.push(...checkStPathConflict(registry.entries));
  errors.push(...checkTransformForShape(registry.entries));
  errors.push(...checkUpOrderSentinel(registry.entries));

  return errors;
}

// ─── 规则 1：id 唯一性 ────────────────────────────────────────────────────────
function checkDuplicateIds(entries: SyncEntry[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Map<string, number>(); // id → 第一次出现的 index

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      errors.push({
        entryId: entry.id,
        rule: 'duplicate_entry_id',
        message: `条目 id '${entry.id}' 重复出现（首次出现在 index ${seen.get(entry.id)}）`,
      });
    } else {
      seen.set(entry.id, entries.indexOf(entry));
    }
  }

  return errors;
}

// ─── 规则 2：分区-方向一致性 ──────────────────────────────────────────────────
// 分区 A → direction 必须是 'down'
// 分区 B → direction 必须是 'up'
function checkPartitionDirectionMismatch(entries: SyncEntry[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const entry of entries) {
    const expectedDirection = entry.partition === 'A' ? 'down' : 'up';
    if (entry.direction !== expectedDirection) {
      errors.push({
        entryId: entry.id,
        rule: 'partition_direction_mismatch',
        message:
          `分区 ${entry.partition} 的条目 '${entry.id}' direction 必须是 '${expectedDirection}'，` +
          `实际为 '${entry.direction}'`,
      });
    }
  }

  return errors;
}

// ─── 规则 3：下发顺序约束（决策 5） ──────────────────────────────────────────
// 所有 asset + down 条目的 order 必须 < 所有 config + down 条目的 order
// 原因：配置层下发时，其中的资产指针必须已有对应文件就位
function checkOrderConstraint(entries: SyncEntry[]): ValidationError[] {
  const errors: ValidationError[] = [];

  const assetDownEntries = entries.filter(
    (e) => e.shape === 'asset' && e.direction === 'down' && e.enabled
  );
  const configDownEntries = entries.filter(
    (e) => e.shape === 'config' && e.direction === 'down' && e.enabled
  );

  // 取资产层最大 order 和配置层最小 order 进行比较
  const maxAssetOrder = Math.max(...assetDownEntries.map((e) => e.order), -Infinity);
  const minConfigOrder = Math.min(...configDownEntries.map((e) => e.order), Infinity);

  if (assetDownEntries.length > 0 && configDownEntries.length > 0) {
    if (maxAssetOrder >= minConfigOrder) {
      // 找出违规的具体条目
      const violatingConfig = configDownEntries.filter((e) => e.order <= maxAssetOrder);
      const violatingAsset = assetDownEntries.filter((e) => e.order >= minConfigOrder);

      for (const entry of [...violatingConfig, ...violatingAsset]) {
        errors.push({
          entryId: entry.id,
          rule: 'order_constraint_violation',
          message:
            `下发顺序违反决策 5：asset 层最大 order=${maxAssetOrder}，` +
            `config 层最小 order=${minConfigOrder}。` +
            `条目 '${entry.id}'（${entry.shape}, order=${entry.order}）导致顺序倒置。` +
            `要求：所有 asset+down 的 order < 所有 config+down 的 order`,
        });
      }
    }
  }

  return errors;
}

// ─── 规则 4：ST 路径冲突 ──────────────────────────────────────────────────────
// 同一个 ST 侧写入目标不能被多个 down 条目覆盖写
// （防止两条规则争抢同一个文件/字段，导致最终结果不确定）
function checkStPathConflict(entries: SyncEntry[]): ValidationError[] {
  const errors: ValidationError[] = [];

  // 只检查下行（down）条目，上行条目各自写各自用户的 B 表，不冲突
  const downEntries = entries.filter((e) => e.direction === 'down');

  // 构建 ST 路径 → 条目列表 的映射
  const pathMap = new Map<string, SyncEntry[]>();
  for (const entry of downEntries) {
    const key = stLocationKey(entry);
    const existing = pathMap.get(key) ?? [];
    existing.push(entry);
    pathMap.set(key, existing);
  }

  // 找出有多个条目写同一路径的情况
  for (const [path, conflictEntries] of pathMap) {
    if (conflictEntries.length > 1) {
      const ids = conflictEntries.map((e) => `'${e.id}'`).join(', ');
      for (const entry of conflictEntries) {
        errors.push({
          entryId: entry.id,
          rule: 'st_path_conflict',
          message: `ST 路径 '${path}' 被多个下行条目写入：${ids}。每个下行目标路径只能有一个写入规则。`,
        });
      }
    }
  }

  return errors;
}

/** 将 StLocation 转换为可比较的字符串 key */
function stLocationKey(entry: SyncEntry): string {
  const { st } = entry;
  if (st.type === 'json_field') {
    return `json_field::${st.file}::${st.field_path}`;
  }
  // asset_file：同一目录下 naming 规则相同视为同一路径
  return `asset_file::${st.directory}::${st.naming}`;
}

// ─── 规则 5：transform 与 shape 的兼容性 ─────────────────────────────────────
// asset 形态的条目只能使用 passthrough transform
// 原因：资产文件的命名规则由 st.naming 控制，transform 对资产条目语义不清晰
function checkTransformForShape(entries: SyncEntry[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const entry of entries) {
    if (entry.shape === 'asset' && entry.transform !== 'passthrough') {
      errors.push({
        entryId: entry.id,
        rule: 'invalid_transform_for_shape',
        message:
          `asset 形态的条目 '${entry.id}' transform 只能是 'passthrough'，` +
          `实际为 '${entry.transform}'。` +
          `资产文件命名由 st.naming 控制，transform 对资产条目无意义。`,
      });
    }
  }

  return errors;
}

// ─── 规则 6：上行条目哨兵值约束 ──────────────────────────────────────────────
// direction=up 的条目 order 必须 >= 900（哨兵值区间），
// 确保上行规则不会被误排入下发队列
const UP_ORDER_SENTINEL_MIN = 900;

function checkUpOrderSentinel(entries: SyncEntry[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const entry of entries) {
    if (entry.direction === 'up' && entry.order < UP_ORDER_SENTINEL_MIN) {
      errors.push({
        entryId: entry.id,
        rule: 'up_order_sentinel_violation',
        message:
          `上行条目 '${entry.id}' 的 order=${entry.order} 小于哨兵值下限 ${UP_ORDER_SENTINEL_MIN}。` +
          `上行规则应使用 order >= ${UP_ORDER_SENTINEL_MIN}（建议 999），` +
          `避免被误排入下发队列。`,
      });
    }
  }

  return errors;
}
