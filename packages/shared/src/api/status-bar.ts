/**
 * 状态栏 v2 的 HTTP 契约。
 *
 * - 聊天页右侧状态面板：GET /api/conversations/:sessionId/status、POST …/status/refresh、POST …/status/undo
 * - 玩家在工具箱里改这张卡的状态栏：GET/PUT/DELETE /api/characters/:characterId/status-bar
 * - 运营给存量卡生成/写入：/api/admin/characters/:characterId/status-bar（GET、POST …/generate、PUT）
 * - 创作者建卡时的 AI：POST /api/creator/status-bar/{generate,describe,complete,edit}（请求体带当前草稿，同 AI 润色）
 *
 * 状态更新不消耗星尘；每 5 轮自动更新所有人都有，手动更新仅限 VIP 且限频。模板语义校验见 status-bar/check.ts。
 */
import { z } from 'zod';
import { CharacterDraftSchema } from './creator-characters';
import {
  StatusBarItemSchema,
  StatusBarTemplateDraftSchema,
  type StatusBarTemplate,
} from '../status-bar/schema';

/** 生效的状态栏来自哪里：玩家改过的 > 卡自带。none = 卡没有状态栏，或玩家关了总开关（不显示、不更新）。 */
export const StatusBarSourceSchema = z.enum(['player', 'card', 'none']);
export type StatusBarSource = z.infer<typeof StatusBarSourceSchema>;

export const STATUS_REFRESH_COOLDOWN_SECONDS = 60;
export const STATUS_AUTO_UPDATE_EVERY_TURNS = 5;

export interface ConversationStatusSnapshot {
  id: string;
  /** 规范状态文本（v2 行语法），前端用 shared 的 parseStatusBody 渲染。 */
  text: string;
  trigger: 'auto' | 'manual';
  createdAt: string;
  /** 能否"撤销这次更新"（有更早的记录或开局值可回）。 */
  canUndo: boolean;
}

export interface ConversationStatusData {
  source: StatusBarSource;
  /** 生效模板；自动模式与关闭时为 null。 */
  template: StatusBarTemplate | null;
  /** 当前路径上最近一次记录；从没更新过为 null（前端显示 initialText）。 */
  snapshot: ConversationStatusSnapshot | null;
  /** 开局状态文本（来自模板开局值）；自动模式为 null。 */
  initialText: string | null;
  /** 后台自动更新进行中。 */
  updating: boolean;
  /** 手动更新只给 VIP；每 5 轮自动更新所有人都有。 */
  manualUpdate: 'allowed' | 'vip_required';
}

export const StatusRefreshErrorCodeSchema = z.enum([
  'STATUS_DISABLED',
  'STATUS_VIP_REQUIRED',
  'STATUS_RATE_LIMITED',
  'STATUS_UPDATE_FAILED',
  'STATUS_BUSY',
]);

export interface CharacterStatusBarData {
  /** 当前对这个玩家生效的来源；none = 卡没有状态栏、玩家也没加。 */
  source: StatusBarSource;
  /** 当前生效模板（玩家改过的或卡自带的）；none 时为 null。 */
  template: StatusBarTemplate | null;
  /** 作者的版本，用于"恢复作者的版本"与对比；卡没有状态栏为 null。 */
  cardTemplate: StatusBarTemplate | null;
}

export const PutCharacterStatusBarRequestSchema = z
  .object({ template: StatusBarTemplateDraftSchema })
  .strict();
export type PutCharacterStatusBarRequest = z.infer<typeof PutCharacterStatusBarRequestSchema>;

/**
 * 作者或玩家写的"方向"：想要什么样的状态栏、想怎么改。生成时可不填（AI 只按角色资料来）；
 * 填了就是最高优先级，AI 只在格式范围内落地。
 */
export const STATUS_BAR_DIRECTION_MAX_CHARS = 500;
const StatusBarDirectionSchema = z.string().trim().max(STATUS_BAR_DIRECTION_MAX_CHARS);
const StatusBarInstructionSchema = StatusBarDirectionSchema.min(1);

/** 创作者 AI：一键生成整栏（可带方向）。 */
export const CreatorStatusBarGenerateRequestSchema = z
  .object({ draft: CharacterDraftSchema, direction: StatusBarDirectionSchema.optional() })
  .strict();
/** 创作者 AI：帮写某一项的说明（这一项已写的说明当作方向扩写；带上整套作参考，避免重复）。 */
export const CreatorStatusBarDescribeRequestSchema = z
  .object({
    draft: CharacterDraftSchema,
    item: StatusBarItemSchema,
    template: StatusBarTemplateDraftSchema.optional(),
  })
  .strict();
/** 创作者 AI：只补全缺说明的项（不改名称和样式）。 */
export const CreatorStatusBarCompleteRequestSchema = z
  .object({ draft: CharacterDraftSchema, template: StatusBarTemplateDraftSchema })
  .strict();
/** 创作者 AI：按方向改整栏。 */
export const CreatorStatusBarEditRequestSchema = z
  .object({
    draft: CharacterDraftSchema,
    template: StatusBarTemplateDraftSchema,
    instruction: StatusBarInstructionSchema,
  })
  .strict();

export type CreatorStatusBarGenerateRequest = z.infer<typeof CreatorStatusBarGenerateRequestSchema>;
export type CreatorStatusBarDescribeRequest = z.infer<typeof CreatorStatusBarDescribeRequestSchema>;
export type CreatorStatusBarCompleteRequest = z.infer<typeof CreatorStatusBarCompleteRequestSchema>;
export type CreatorStatusBarEditRequest = z.infer<typeof CreatorStatusBarEditRequestSchema>;

export interface CreatorStatusBarTemplateData {
  template: StatusBarTemplate;
  /** AI 为了守格式做了取舍时的一句说明（比如"要的项太多，合并了两项"）；没有就是空串。 */
  remark?: string;
}
export interface CreatorStatusBarDescribeData {
  desc: string;
}

/**
 * 玩家在工具箱里让 AI 帮忙（只对自己、只对这张卡）：按方向生成整栏、按方向改整栏、帮写一项说明。
 * 角色资料由后端按卡读取，不从前端传。结果只回给前端，玩家确认后照常走 PUT 保存。
 */
export const PlayerStatusBarAiRequestSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('generate'), direction: StatusBarDirectionSchema.optional() })
    .strict(),
  z
    .object({
      action: z.literal('edit'),
      template: StatusBarTemplateDraftSchema,
      instruction: StatusBarInstructionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('describe'),
      item: StatusBarItemSchema,
      template: StatusBarTemplateDraftSchema.optional(),
    })
    .strict(),
]);
export type PlayerStatusBarAiRequest = z.infer<typeof PlayerStatusBarAiRequestSchema>;
export type PlayerStatusBarAiData =
  | { action: 'generate' | 'edit'; template: StatusBarTemplate; remark: string }
  | { action: 'describe'; desc: string };

// ── 运营：给存量卡批量生成状态栏（运营 CLI → /api/admin/characters/:id/status-bar/*） ────────

/** 运营批量生成默认用的模型；可在请求里换。 */
export const ADMIN_STATUS_BAR_DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';

/** 只生成、不保存：CLI 汇总给运营看，确认后再走 PUT 写入。 */
export const AdminStatusBarGenerateRequestSchema = z
  .object({ model: z.string().trim().min(3).max(100).optional() })
  .strict();
export type AdminStatusBarGenerateRequest = z.infer<typeof AdminStatusBarGenerateRequestSchema>;

export const AdminStatusBarGenerateDataSchema = z.object({
  characterId: z.string(),
  name: z.string(),
  model: z.string(),
  template: StatusBarTemplateDraftSchema,
  durationMs: z.number(),
});
export type AdminStatusBarGenerateData = z.infer<typeof AdminStatusBarGenerateDataSchema>;

/** template = null 清空卡上的状态栏。 */
export const AdminSetStatusBarRequestSchema = z
  .object({ template: StatusBarTemplateDraftSchema.nullable() })
  .strict();
export type AdminSetStatusBarRequest = z.infer<typeof AdminSetStatusBarRequestSchema>;

/** 卡上已有的状态栏可能是旧格式或不合格，读出来认不出时当作没有。 */
const StoredStatusBarSchema = StatusBarTemplateDraftSchema.nullable().catch(null);

export const AdminCharacterStatusBarDataSchema = z.object({
  characterId: z.string(),
  name: z.string(),
  template: StoredStatusBarSchema,
});
export type AdminCharacterStatusBarData = z.infer<typeof AdminCharacterStatusBarDataSchema>;

export const AdminSetStatusBarDataSchema = z.object({
  characterId: z.string(),
  previous: StoredStatusBarSchema,
  template: StatusBarTemplateDraftSchema.nullable(),
  /** 创作卡：作者草稿里原本没有状态栏，这次一并补进了草稿。 */
  draftPatched: z.boolean(),
});
export type AdminSetStatusBarData = z.infer<typeof AdminSetStatusBarDataSchema>;

/** 按收藏量从高到低列卡（不含已删除、测试卡），批量生成先跑头部卡。 */
export const ADMIN_STATUS_BAR_TOP_MAX = 500;
export const AdminStatusBarTopCardSchema = z.object({
  characterId: z.string(),
  name: z.string(),
  favoriteCount: z.number().int().nonnegative(),
  hasStatusBar: z.boolean(),
});
export type AdminStatusBarTopCard = z.infer<typeof AdminStatusBarTopCardSchema>;
export const AdminStatusBarTopDataSchema = z.object({
  cards: z.array(AdminStatusBarTopCardSchema),
});
export type AdminStatusBarTopData = z.infer<typeof AdminStatusBarTopDataSchema>;
