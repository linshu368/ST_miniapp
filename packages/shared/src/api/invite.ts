/**
 * shared / api / invite.ts
 *
 * 裂变邀请（invite program）前后端契约。
 * 设计依据：docs/裂变工程落地实施方案.md + docs/裂变阶段一实施计划.md。
 */

/**
 * 邀请深链在 Telegram startapp 参数中的前缀。
 * start_param 通道由渠道归因（source_id）、支付回跳（payment_return_）与邀请共用，
 * 前端在 getStartParam() 分发时按前缀区分，见 providers.tsx。
 */
export const INVITE_START_PARAM_PREFIX = 'inv_';

/** 邀请链接进入的用户在 users.source_id 记录的固定渠道值。 */
export const INVITE_SOURCE_ID = 'invite';

/** GET /api/invite/entry-status —— "我的"页邀请中心入口的展示状态。 */
export interface InviteEntryStatusData {
  /** 运营总开关（miniapp_invite_entry_enabled）；false 时隐藏全部邀请入口。 */
  entry_enabled: boolean;
  /** 用户是否已首次进入过邀请中心；false 时入口展示"2200星尘"提醒标签。 */
  center_entered: boolean;
}

/** POST /api/invite/center-view —— 进入邀请中心（副作用：懒生成邀请码、标记首次进入）。 */
export interface InviteCenterViewData {
  /** 用户专属邀请码（8 位大写，永久固定）。 */
  invite_code: string;
  /** 完整专属链接：https://t.me/{bot}/{app}?startapp=inv_{code}。 */
  invite_link: string;
  /** 已发布邀请海报 URL；空串表示运营尚未发布，前端降级不展示。 */
  poster_url: string;
  /** 已发布文案库（刷新按钮轮换来源）；{link} 占位符由前端替换为 invite_link。 */
  copy_templates: string[];
  /** 本次是否为首次进入邀请中心。 */
  first_visit: boolean;
}

export interface InviteBindRequest {
  /** 邀请码（前端已剥去 inv_ 前缀）。 */
  invite_code: string;
}

/**
 * 绑定结果。除 invalid_code 外均为幂等终态，前端可安全重试：
 * - bound：本次成功建立关系；
 * - already_bound：此前已有关系（含并发重复请求），不覆盖；
 * - self_invite：自邀，不建立关系；
 * - not_new_user：已有账户（超出新用户判定窗），不建立关系；
 * - invalid_code：邀请码不存在或无效。
 */
export type InviteBindStatus =
  | 'bound'
  | 'already_bound'
  | 'self_invite'
  | 'not_new_user'
  | 'invalid_code';

export interface InviteBindData {
  status: InviteBindStatus;
}

/** 数据中心的一条到账记录。 */
export interface InviteRewardRecord {
  credits: number;
  /** 触发规则，如 invitee_registered。 */
  rule_key: string;
  /** ISO 时间串。 */
  granted_at: string;
}

/** GET /api/invite/stats —— 邀请数据中心。 */
export interface InviteStatsData {
  /** 累计邀请人数（有效绑定的下级用户数）。 */
  invited_count: number;
  /** 累计获得星尘。 */
  total_reward_credits: number;
  /** 最近到账记录（按时间倒序）。 */
  recent_rewards: InviteRewardRecord[];
  /** 数据更新时间（实时模式下即查询时刻），ISO 时间串。 */
  updated_at: string;
  /** 本期恒为 realtime；batch 为批量降级预案占位。 */
  update_mode: 'realtime' | 'batch';
}
