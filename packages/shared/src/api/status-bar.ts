/**
 * 状态栏 v2 的 HTTP 契约。
 *
 * - 聊天页右侧状态面板：GET /api/conversations/:sessionId/status、POST …/status/refresh、POST …/status/undo
 * - 玩家在工具箱里改这张卡的状态栏：GET/PUT/DELETE /api/characters/:characterId/status-bar
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

/** 生效的状态栏来自哪里：玩家改过的 > 卡自带 > 自动（旧卡没有状态栏）。none = 玩家关了总开关。 */
export const StatusBarSourceSchema = z.enum(['player', 'card', 'auto', 'none']);
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
  /** 当前对这个玩家生效的来源。 */
  source: Exclude<StatusBarSource, 'none'>;
  /** 当前生效模板（玩家改过的或卡自带的）；自动模式为 null。 */
  template: StatusBarTemplate | null;
  /** 作者的版本，用于"恢复作者的版本"与对比；卡没有状态栏为 null。 */
  cardTemplate: StatusBarTemplate | null;
}

export const PutCharacterStatusBarRequestSchema = z
  .object({ template: StatusBarTemplateDraftSchema })
  .strict();
export type PutCharacterStatusBarRequest = z.infer<typeof PutCharacterStatusBarRequestSchema>;

/** 创作者 AI：一键生成整栏。 */
export const CreatorStatusBarGenerateRequestSchema = z
  .object({ draft: CharacterDraftSchema })
  .strict();
/** 创作者 AI：帮写某一项的说明。 */
export const CreatorStatusBarDescribeRequestSchema = z
  .object({ draft: CharacterDraftSchema, item: StatusBarItemSchema })
  .strict();
/** 创作者 AI：只补全缺说明的项（不改名称和样式）。 */
export const CreatorStatusBarCompleteRequestSchema = z
  .object({ draft: CharacterDraftSchema, template: StatusBarTemplateDraftSchema })
  .strict();
/** 创作者 AI：一句话改整栏。 */
export const CreatorStatusBarEditRequestSchema = z
  .object({
    draft: CharacterDraftSchema,
    template: StatusBarTemplateDraftSchema,
    instruction: z.string().trim().min(1).max(200),
  })
  .strict();

export type CreatorStatusBarGenerateRequest = z.infer<typeof CreatorStatusBarGenerateRequestSchema>;
export type CreatorStatusBarDescribeRequest = z.infer<typeof CreatorStatusBarDescribeRequestSchema>;
export type CreatorStatusBarCompleteRequest = z.infer<typeof CreatorStatusBarCompleteRequestSchema>;
export type CreatorStatusBarEditRequest = z.infer<typeof CreatorStatusBarEditRequestSchema>;

export interface CreatorStatusBarTemplateData {
  template: StatusBarTemplate;
}
export interface CreatorStatusBarDescribeData {
  desc: string;
}
