// drama_archive 的只读取数层。
//
// 只做数据库访问、播放排序和最小形状归一化：把 pipeline_tasks 的任务行收敛成一个
// upload_succeeded 布尔值，原始任务行不离开本文件。对外类型的组装在 assemble.ts。
//
// 基础表由 telegram-video-archive 管理，展示时间扩展经本仓库 migration 通道。
// 这里不用 Prisma，走 PostgREST（getDomainDb('drama_archive')）。

import { getDomainDb, type DomainDb } from '../../lib/supabase.js';

/** 外部查询超时。/play 在首帧关键路径上，不允许无限等待 */
const QUERY_TIMEOUT_MS = 5000;

/**
 * 剧级 AI 必须经 drama_id 读取；source_video_id 只是生成来源，不能当成单集 AI。
 * 视频只提供可播/封面就绪和首次上架时间，不参与剧级文字回退。
 */
const LIST_COLUMNS =
  'id,title,tags,description,ai_results!ai_results_drama_fkey(title,tags,description),videos(id,episode,message_id,created_at,object_path,cover_path,pipeline_tasks(stage,status))';

/** 详情页额外读取各集自己的原始展示字段 */
const DETAIL_COLUMNS =
  'id,title,tags,description,ai_results!ai_results_drama_fkey(title,tags,description),videos(id,episode,message_id,created_at,object_path,cover_path,original_title,original_tags,original_description,pipeline_tasks(stage,status))';

/**
 * /play 只需要定位对象和判定就绪，不取任何展示字段。
 * 这是首帧关键路径，payload 越小越好。
 */
const PLAY_COLUMNS =
  'id,title,videos(id,episode,message_id,object_path,pipeline_tasks(stage,status))';

/** repository 对外的视频投影。object_path 仅供签名使用，不得出现在响应里 */
export interface VideoRow {
  id: string;
  episode: string | null;
  object_path: string | null;
  /** pipeline_tasks 中 stage='upload' 的 status 是否为 succeeded */
  upload_succeeded: boolean;
  cover_path: string | null;
  /** pipeline_tasks 中 stage='cover_upload' 的 status 是否为 succeeded */
  cover_upload_succeeded: boolean;
  original_title: string | null;
  original_tags: string[];
  original_description: string | null;
  created_at: string | null;
}

/** repository 对外的短剧投影。videos 已按播放顺序排好 */
export interface DramaRow {
  id: string;
  title: string | null;
  tags: string[];
  description: string | null;
  ai_title: string | null;
  ai_tags: string[];
  ai_description: string | null;
  videos: VideoRow[];
}

/** PostgREST 返回的嵌套行，只在本文件内使用 */
interface RawVideo {
  id: string;
  episode: string | null;
  message_id: number;
  object_path: string | null;
  cover_path?: string | null;
  original_title?: string | null;
  original_tags?: string[] | null;
  original_description?: string | null;
  created_at?: string | null;
  pipeline_tasks?: { stage: string; status: string }[] | null;
}

interface RawDrama {
  id: string;
  title: string | null;
  tags?: string[] | null;
  description?: string | null;
  ai_results?: {
    title: string | null;
    tags: string[];
    description: string | null;
  } | null;
  videos?: RawVideo[] | null;
}

function toVideoRow(raw: RawVideo): VideoRow {
  // 嵌套查询按需过滤 stage，这里仍显式判断 stage，
  // 避免将来过滤条件变动后把别的阶段的状态当成上传/封面结果。
  const upload = (raw.pipeline_tasks ?? []).find((t) => t.stage === 'upload');
  const coverUpload = (raw.pipeline_tasks ?? []).find((t) => t.stage === 'cover_upload');
  return {
    id: raw.id,
    episode: raw.episode,
    object_path: raw.object_path,
    upload_succeeded: upload?.status === 'succeeded',
    cover_path: raw.cover_path ?? null,
    cover_upload_succeeded: coverUpload?.status === 'succeeded',
    original_title: raw.original_title ?? null,
    original_tags: raw.original_tags ?? [],
    original_description: raw.original_description ?? null,
    created_at: raw.created_at ?? null,
  };
}

/**
 * 固定播放顺序：episode 数字升序（空值排最后），再按 message_id 升序。
 *
 * episode 目前全库为空，实际生效的是 message_id —— Telegram 话题里的消息按发布
 * 时间递增，等于上传顺序。已知偏差：集与集之间插入的花絮会被排进正片序列，
 * 需要归档端补充集数标记才能区分，本期不处理。
 */
function comparePlayOrder(a: RawVideo, b: RawVideo): number {
  const na = Number(a.episode);
  const nb = Number(b.episode);
  const va = a.episode !== null && a.episode.trim() !== '' && Number.isFinite(na);
  const vb = b.episode !== null && b.episode.trim() !== '' && Number.isFinite(nb);
  if (va && vb && na !== nb) return na - nb;
  if (va !== vb) return va ? -1 : 1;
  return a.message_id - b.message_id;
}

function toDramaRow(raw: RawDrama): DramaRow {
  const videos = [...(raw.videos ?? [])].sort(comparePlayOrder).map(toVideoRow);
  return {
    id: raw.id,
    title: raw.title,
    tags: raw.tags ?? [],
    description: raw.description ?? null,
    ai_title: raw.ai_results?.title ?? null,
    ai_tags: raw.ai_results?.tags ?? [],
    ai_description: raw.ai_results?.description ?? null,
    videos,
  };
}

export class DramaRepository {
  constructor(private readonly db: DomainDb = getDomainDb('drama_archive')) {}

  /** 嵌套过滤只保留指定阶段的任务行，别的阶段不进内存 */
  private query(columns: string, stages: string[] = ['upload']) {
    return this.db
      .from('dramas')
      .select(columns)
      .in('videos.pipeline_tasks.stage', stages)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));
  }

  /** 全目录用于前端检索；TEST 已核验顶层/单剧数量均低于 PostgREST 行上限。 */
  async listDramas(): Promise<DramaRow[]> {
    const { data, error } = await this.query(LIST_COLUMNS, ['upload', 'cover_upload']);
    if (error) throw new Error('drama list read failed');
    return ((data as unknown as RawDrama[] | null) ?? []).map(toDramaRow);
  }

  /** 详情页。短剧不存在返回 null，由路由转成 404 */
  async getDrama(id: string): Promise<DramaRow | null> {
    const { data, error } = await this.query(DETAIL_COLUMNS, ['upload', 'cover_upload'])
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error('drama detail read failed');
    return data ? toDramaRow(data as unknown as RawDrama) : null;
  }

  /**
   * /play 用的精简读取：只够判定归属和就绪，不含展示字段。
   * 返回整部剧而不是单条视频，这样未指定 video_id 时能按固定顺序选第一条，
   * 指定了也能在同一次查询里校验视频确实属于这部剧。
   */
  async getDramaForPlayback(id: string): Promise<DramaRow | null> {
    const { data, error } = await this.query(PLAY_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw new Error('drama playback read failed');
    return data ? toDramaRow(data as unknown as RawDrama) : null;
  }
}
