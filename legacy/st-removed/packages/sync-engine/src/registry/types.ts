/**
 * sync-engine / registry / types.ts
 *
 * 配置清单的完整类型定义。
 * 所有同步规则通过 registry.yaml 声明，此处对应的 TS 类型是唯一的真相源。
 *
 * 两个维度正交（与 Schema划分设计.md 第四章一致）：
 *   维度 1 - 分区归属（Partition）：决定真相源 / 数据流方向 / 冲突策略
 *   维度 2 - 数据形态（Shape）：决定在 ST 文件系统中如何存储
 */

// ─── 维度 1：分区归属 ─────────────────────────────────────────────────────────
/** A = 平台管控（Supabase 绝对真相，单向下发到 ST）
 *  B = 用户运行时（ST 文件系统 runtime 真相源，异步镜像到 Supabase）
 */
export type Partition = 'A' | 'B';

// ─── 维度 2：数据形态 ─────────────────────────────────────────────────────────
/** config = 配置型：对应 settings.json 这类单个 JSON 大文件，整块版本快照
 *  asset  = 资产型：对应 characters/、OpenAI Settings/ 下的独立文件，一行一资产
 */
export type Shape = 'config' | 'asset';

// ─── 数据流方向（由分区归属决定，validator 会校验一致性） ──────────────────────
/** down = Supabase → ST 文件系统（分区 A 专属）
 *  up   = ST 文件系统 → Supabase（分区 B 专属）
 */
export type Direction = 'down' | 'up';

// ─── 同步触发时机 ─────────────────────────────────────────────────────────────
/** init          = 首次初始化：新用户进入时全量分发
 *  session_start = 每次登录投影：用户重新登录时重建 ST 工作目录
 *  watch         = 文件 watch：ST 文件系统变更后异步触发（仅分区 B 使用）
 */
export type Trigger = 'init' | 'session_start' | 'watch';

// ─── Transform 类型（决策 3） ─────────────────────────────────────────────────
/**
 * passthrough    = 原样搬运，不做值变换
 * character_ref  = 值是 platform_<uuid>.png 指针；投影阶段校验 miniapp.characters 是否存在，
 *                  失效时回退默认卡（决策 8）。写入 B 表时不校验（决策 4 已确认）。
 * preset_ref     = 预留：预设指针（阶段一 schema 预留，code 未实现）
 * world_ref      = 预留：世界书指针
 * model_tier_ref = 预留：模型等级指针
 */
export type Transform =
  | 'passthrough'
  | 'character_ref'
  | 'preset_ref'
  | 'world_ref'
  | 'model_tier_ref';

// ─── ST 侧位置描述 ────────────────────────────────────────────────────────────
/**
 * json_field = settings.json（或其他 JSON 文件）中的某个字段路径
 *   - file       : 相对 data/<handle>/ 的文件路径，如 'settings.json'
 *   - field_path : lodash dot-path；'*' 表示整个文件
 *
 * asset_file = 独立资产文件（角色卡 PNG、预设 JSON 等）
 *   - directory : 相对 data/<handle>/ 的目录，如 'characters' / 'OpenAI Settings'
 *   - naming    : 文件命名规则；阶段一只支持 'platform_uuid'（→ platform_<uuid>.ext）
 */
export type StLocation =
  | {
      type: 'json_field';
      /** 相对 data/<handle>/ 的文件路径 */
      file: string;
      /** lodash dot-path，'*' 表示整个文件 */
      field_path: string;
    }
  | {
      type: 'asset_file';
      /** 相对 data/<handle>/ 的资产目录 */
      directory: string;
      /** 落盘命名规则：阶段一只有 platform_uuid */
      naming: 'platform_uuid';
    };

// ─── Supabase 侧位置描述 ──────────────────────────────────────────────────────
export interface SupabaseLocation {
  /** PostgreSQL schema 名，如 'st' / 'miniapp' / 'public' */
  schema: string;
  /** 表名 */
  table: string;
  /**
   * 列名；对于 jsonb 列可带 dot-path，如 'settings_jsonb.active_character'。
   * '*' 表示整行（资产型条目：同步引擎负责将整行数据序列化为目标文件格式）。
   */
  column: string;
}

// ─── 完整同步条目 ─────────────────────────────────────────────────────────────
export interface SyncEntry {
  /** 全局唯一标识，kebab-case，如 'platform_characters_down' */
  id: string;

  /** 人读描述，用于 CLI 摘要和错误信息 */
  label: string;

  /** 分区归属（决定真相源和冲突策略） */
  partition: Partition;

  /** 数据形态（决定 ST 侧存储方式） */
  shape: Shape;

  /** 数据流方向（必须与 partition 一致，validator 校验） */
  direction: Direction;

  /** ST 文件系统侧描述 */
  st: StLocation;

  /** Supabase 侧描述 */
  supabase: SupabaseLocation;

  /**
   * 触发时机列表（可多选）
   * watch 只能出现在 partition=B 的条目中
   */
  triggers: Trigger[];

  /**
   * 值变换类型（决策 3）
   * - asset 形态的条目只能用 passthrough（命名规则由 naming 字段控制，不是 transform）
   * - character_ref 只能用在值类型为"文件名字符串"的 json_field 条目
   */
  transform: Transform;

  /**
   * 下发执行顺序（数字越小越先执行）
   * 约束（决策 5）：asset + down 条目的 order < config + down 条目的 order
   * up 方向的条目用哨兵值 999，不参与下发排序
   */
  order: number;

  /** 是否启用（false = 规则声明保留但不被同步引擎消费，便于灰度和临时下线） */
  enabled: boolean;

  /** 可选：给运维/开发看的补充说明 */
  notes?: string;
}

// ─── 清单文件顶层结构 ─────────────────────────────────────────────────────────
export interface SyncRegistry {
  /**
   * 清单自身的版本号（独立于 platform_version）。
   * 清单结构变化时递增，用于排查"用了旧版清单"类问题。
   */
  version: number;

  /** 所有同步条目 */
  entries: SyncEntry[];
}
