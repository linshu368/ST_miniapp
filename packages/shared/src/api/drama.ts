import { z } from 'zod';

// 短剧浏览与播放契约。
//
// 数据源是 telegram-video-archive 直接建在 Supabase 上的 drama_archive schema，
// 基础表由归档仓库管理，展示时间扩展经本仓库 migration 通道。
// 对外只暴露展示字段，不透传数据库行、object_path、
// Telegram 定位信息（source_id / message_id / media_id）或任务表记录。
//
// 播放地址刻意不放在列表/详情里：点击卡片只发一次 GET /api/dramas/:id/play，
// 后端只给选中那一条视频签一个临时 URL，避免进页面时为全量视频签名。

/** 列表页用的精简结构 */
export interface DramaSummary {
  id: string;
  /** 剧级原始标题 → 同剧 AI 标题 → 空串；空白视为缺失 */
  title: string;
  /**
   * 封面图。取第一条可播视频的封面（cover_path 非空且 cover_upload 阶段已确认成功），
   * drama-covers 是公开桶，这里直接是可访问的公开地址，不是签名链接。
   * 封面还没归档完成时为 null，前端渲染占位。
   */
  cover_url: string | null;
  /**
   * 有效标签：原始标签优先，为空回退 AI 标签，都空为 []。
   * 只用 dramas / 同剧 ai_results，不借用单集信息、不混合来源。
   * 全量返回，列表卡片由前端截断展示。
   */
  tags: string[];
  /**
   * 简介：只用 dramas / 同剧 ai_results，不随播放中的集数变化。
   * 原始简介非空用原始，否则 AI 简介，都空则 ''。
   */
  description: string;
  /**
   * 可播视频 created_at 的最早值，ISO 8601；全部缺失为 null。
   * 存量可能为补录排序时间，并非真实历史上传时间。旧 Backend 可缺此字段。
   */
  first_published_at?: string | null;
  /**
   * 可播放的集数，即 playable=true 的视频条数；0 表示暂无可用集数。
   * 与 DramaDetail.videos 的长度口径一致。
   */
  episode_count: number;
  /**
   * 单集时长（秒）。目前恒为 null，待归档端从 Telegram
   * DocumentAttributeVideo.duration 登记进库后自动有值。
   * 徽标规则：episode_count === 1 时显示时长，> 1 时显示集数。
   */
  duration_seconds: number | null;
}

/** 详情页的单个视频 */
export interface VideoItem {
  id: string;
  /** 单集原始标题，空白/缺失为 ''；剧级 AI 不冒充单集元数据 */
  title: string;
  /** 单集原始标签，去空项、去重；缺失为 [] */
  tags: string[];
  /** 单集原始简介，空白/缺失为 '' */
  description: string;
  /** 集数标签，直接取 videos.episode，无回退 */
  episode: string | null;
  /**
   * 上传已成功（pipeline_tasks upload/succeeded）且 object_path 非空。
   * 只表示持久就绪状态，不代表本次签名一定成功；
   * 本次签名是否成功看 DramaPlayback.playable。
   */
  playable: boolean;
}

/**
 * 详情页。videos 已按播放顺序排好（episode 数字升序，缺省回退 message_id 升序），
 * 数组下标即集数顺序，前端 ended 事件后取下一项的 id 请求 /play。
 * 只包含 playable=true 的条目，与 DramaSummary.episode_count 口径一致。
 */
export interface DramaDetail extends DramaSummary {
  videos: VideoItem[];
}

/** 播放地址。唯一包含临时签名 URL 的对外结构 */
export interface DramaPlayback {
  /** 本次选中的视频；整部剧都不可播时为 null，没有视频可指 */
  video_id: string | null;
  /** 本次是否拿到可用播放地址；签名失败或超时为 false，不影响元数据 */
  playable: boolean;
  play_url: string | null;
  /** 签名有效期终点的 ISO 8601 时间，失败时为 null */
  expires_at: string | null;
}

// GET /api/dramas 的响应体
export interface GetDramasData {
  dramas: DramaSummary[];
}

// GET /api/dramas/:id 的响应体
export interface GetDramaByIdData {
  drama: DramaDetail;
}

// GET /api/dramas/:id/play 的响应体
export interface GetDramaPlaybackData {
  playback: DramaPlayback;
}

/** One Preview-only experiment; these identifiers never select a database row. */
export const DRAMA_CDN_SAMPLE_ID = '1fc8b3d5-9426-5ce6-b675-d98074da4801';
export const DramaCdnRouteSchema = z.enum(['original', 'bunny']);
export type DramaCdnRoute = z.infer<typeof DramaCdnRouteSchema>;
export const DramaCdnPlaybackQuerySchema = z
  .object({
    video_id: z.literal(DRAMA_CDN_SAMPLE_ID),
    route: DramaCdnRouteSchema,
  })
  .strict();

const CdnOutcome = z.enum([
  'pending',
  'playing',
  'error',
  'unplayable',
  'autoplay_blocked',
  'switched',
  'left',
  'background',
  'address_error',
  'timeout',
  'interrupted',
]);
const CdnDuration = z.number().finite().nonnegative().max(600_000);
const CdnSeconds = z.number().finite().nonnegative().max(1e7);
const CdnRelease = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/);
/** Bounded experiment evidence only: no arbitrary text, URLs, headers, or media credentials. */
export const DramaCdnEvidenceSchema = z
  .object({
    type: z.literal('cdn_experiment'),
    schema_version: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    release: CdnRelease,
    sample: z.literal(DRAMA_CDN_SAMPLE_ID),
    bytes: z.literal(46518538),
    same_phone_network_proxy: z.boolean(),
    formal_started: z.boolean(),
    closed: z.boolean(),
    automatic: z.boolean(),
    muted: z.boolean(),
    platform: z.enum(['ios', 'android', 'desktop', 'unknown']),
    trials: z
      .array(
        z
          .object({
            sequence: z.number().int().min(1).max(18),
            route: DramaCdnRouteSchema,
            purpose: z.enum(['formal', 'functional', 'fallback']),
            started_at: z.string().datetime(),
            release: CdnRelease.optional(),
            startup_outcome: CdnOutcome,
            startup_ms: CdnDuration.optional(),
            startup_ready_ms: CdnDuration.optional(),
            elapsed_ms: CdnDuration.optional(),
            source_to_frame_ms: CdnDuration.optional(),
            frame_method: z.enum(['video_frame_callback', 'playing_and_timeupdate']).optional(),
            media_error: z.number().int().min(1).max(4).optional(),
            startup_cache: z.literal('UNKNOWN'),
            seek_cache: z.literal('UNKNOWN'),
            fallback_from_seconds: CdnSeconds.optional(),
            fallback_resumed_seconds: CdnSeconds.optional(),
            interruption: z.literal('before_seek').optional(),
            after_startup_outcome: CdnOutcome.optional(),
            seek: z
              .object({
                outcome: z.enum([
                  'playing',
                  'timeout',
                  'error',
                  'buffered',
                  'unknown_buffer',
                  'interrupted',
                ]),
                target_seconds: CdnSeconds,
                buffered: z.array(z.tuple([CdnSeconds, CdnSeconds])).max(16),
                target_frame_ms: CdnDuration.optional(),
                resumed_ms: CdnDuration.optional(),
                frame_method: z.enum(['video_frame_callback', 'playing_and_timeupdate']),
                media_error: z.number().int().min(1).max(4).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
      )
      .max(18),
  })
  .strict();
export type DramaCdnEvidence = z.infer<typeof DramaCdnEvidenceSchema>;

/** 互动只针对官方发布的剧，不包含创作者或关注关系。 */
export interface DramaSocial {
  liked: boolean;
  like_count: number;
  comment_count: number;
}

export const SetDramaLikeSchema = z.object({ liked: z.boolean() }).strict();
export const CreateDramaCommentSchema = z
  .object({
    /** 重试复用同一个 ID，避免网络超时后重复发表。 */
    id: z.string().uuid(),
    body: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)),
  })
  .strict();
export type CreateDramaComment = z.infer<typeof CreateDramaCommentSchema>;

export interface DramaComment {
  id: string;
  /** 稳定匿名剧友名，不暴露用户 ID、用户名或 Telegram 资料。 */
  author: string;
  is_mine: boolean;
  body: string;
  created_at: string;
}

export interface GetDramaSocialData {
  social: DramaSocial;
}
export interface GetDramaCommentsData {
  comments: DramaComment[];
  next_cursor: string | null;
}
export interface CreateDramaCommentData {
  comment: DramaComment;
}
