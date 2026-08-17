/**
 * sync-engine / registry / schema.ts
 *
 * Zod 结构型校验 schema。
 * 职责：确保从 YAML 加载的原始数据在类型层面合法
 *（字段存在、类型正确、枚举值合法）。
 *
 * 注意：跨条目的业务规则（如分区-方向一致性、下发顺序约束）
 * 在 validator.ts 中处理，不在此处。
 */

import { z } from 'zod';

// ─── 基础枚举 ────────────────────────────────────────────────────────────────
export const PartitionSchema = z.enum(['A', 'B']);

export const ShapeSchema = z.enum(['config', 'asset']);

export const DirectionSchema = z.enum(['down', 'up']);

export const TriggerSchema = z.enum(['init', 'session_start', 'watch']);

export const TransformSchema = z.enum([
  'passthrough',
  'character_ref',
  'preset_ref',
  'world_ref',
  'model_tier_ref',
]);

// ─── ST 侧位置描述 ────────────────────────────────────────────────────────────
export const StLocationJsonFieldSchema = z.object({
  type: z.literal('json_field'),
  file: z.string().min(1),
  field_path: z.string().min(1),
});

export const StLocationAssetFileSchema = z.object({
  type: z.literal('asset_file'),
  directory: z.string().min(1),
  naming: z.literal('platform_uuid'),
});

export const StLocationSchema = z.discriminatedUnion('type', [
  StLocationJsonFieldSchema,
  StLocationAssetFileSchema,
]);

// ─── Supabase 侧位置描述 ──────────────────────────────────────────────────────
export const SupabaseLocationSchema = z.object({
  schema: z.string().min(1),
  table: z.string().min(1),
  column: z.string().min(1),
});

// ─── 完整同步条目 ─────────────────────────────────────────────────────────────
export const SyncEntrySchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, {
      message: 'id 必须为 snake_case（小写字母 + 数字 + 下划线，字母开头）',
    }),
  label: z.string().min(1),
  partition: PartitionSchema,
  shape: ShapeSchema,
  direction: DirectionSchema,
  st: StLocationSchema,
  supabase: SupabaseLocationSchema,
  triggers: z.array(TriggerSchema).min(1, { message: 'triggers 至少需要一个触发时机' }),
  transform: TransformSchema,
  order: z.number().int().min(0).max(999),
  enabled: z.boolean(),
  notes: z.string().optional(),
});

// ─── 清单文件顶层结构 ─────────────────────────────────────────────────────────
export const SyncRegistrySchema = z.object({
  version: z.number().int().positive(),
  entries: z.array(SyncEntrySchema),
});

// ─── 导出推导类型（与 types.ts 保持同构，Zod 推导是 runtime 类型安全的来源） ──
export type SyncEntryInput = z.input<typeof SyncEntrySchema>;
export type SyncRegistryInput = z.input<typeof SyncRegistrySchema>;
