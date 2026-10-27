// 把 repository 的数据库投影组装成 shared 的对外类型。
//
// 剧级回退规则来自本任务 PRD 和已核验的剧级 AI schema：逐字段回退，
// 不整行替换、不混合两边的标签、不编造信息。原始字段优先，AI 结果只在原始缺失时顶上，
// 所以 AI 跑完之后前端不需要改动。

import type { DramaDetail, DramaSummary, VideoItem } from '@miniapp/shared';
import type { DramaRow, VideoRow } from './repository.js';

/**
 * 可播判定：上传任务确认成功**且**对象路径非空，两个条件都要。
 *
 * 不能只看 object_path —— 归档端的上传和落库不是跨服务原子事务（见 §4），
 * 存在对象已上传但状态未落库、或路径写入失败的中间态。
 * 这只表示持久就绪状态，本次签名是否成功是 DramaPlayback.playable 的事。
 */
export function isPlayable(video: VideoRow): boolean {
  return video.upload_succeeded && video.object_path !== null && video.object_path !== '';
}

/** 封面就绪判定：和 isPlayable 一个思路，cover_upload 阶段确认成功且路径非空 */
function isCoverReady(video: VideoRow): boolean {
  return video.cover_upload_succeeded && video.cover_path !== null && video.cover_path !== '';
}

/** 字符串逐字段回退：原始 → AI → 空串。空白串视为缺失 */
function fallbackText(original: string | null, ai: string | null): string {
  return original?.trim() || ai?.trim() || '';
}

/** 去掉空项并去重，顺序保持原样 */
function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const trimmed = tag?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** 标签整组回退：原始去空去重后非空就用原始，否则用 AI，都空则 [] */
function fallbackTags(original: string[], ai: string[]): string[] {
  const fromOriginal = normalizeTags(original);
  return fromOriginal.length > 0 ? fromOriginal : normalizeTags(ai);
}

function toVideoItem(video: VideoRow): VideoItem {
  return {
    id: video.id,
    title: video.original_title?.trim() || '',
    tags: normalizeTags(video.original_tags),
    description: video.original_description?.trim() || '',
    // 集数标签没有回退来源，原样透出
    episode: video.episode,
    playable: isPlayable(video),
  };
}

/**
 * 列表卡片。
 *
 * 剧级文字逐字段回退，封面仍取首条可播视频。tags/description 全量返回用于搜索。
 *
 * buildCoverUrl 由调用方注入（而不是在本模块直接依赖 Supabase 客户端），
 * 保持 assemble.ts 是纯函数、不做 I/O，方便单测和替身。
 */
export function toDramaSummary(
  drama: DramaRow,
  buildCoverUrl: (coverPath: string) => string
): DramaSummary {
  const playable = drama.videos.filter(isPlayable);
  const first = playable[0];
  // 只聚合可播视频；缺时间的集不伪造时间，也不能让未就绪集提前影响上架排序。
  const publishedTimes = playable
    .map((video) => (video.created_at ? Date.parse(video.created_at) : NaN))
    .filter(Number.isFinite);
  return {
    id: drama.id,
    title: fallbackText(drama.title, drama.ai_title),
    cover_url: first && isCoverReady(first) ? buildCoverUrl(first.cover_path!) : null,
    tags: fallbackTags(drama.tags, drama.ai_tags),
    description: fallbackText(drama.description, drama.ai_description),
    first_published_at:
      publishedTimes.length > 0 ? new Date(Math.min(...publishedTimes)).toISOString() : null,
    episode_count: playable.length,
    // 待归档端把 Telegram 的 DocumentAttributeVideo.duration 登记进库
    duration_seconds: null,
  };
}

/**
 * 详情页。videos 只含可播条目，与 episode_count 口径一致 ——
 * 否则列表显示 10 集、详情列出 12 集，用户点到放不出来的那两集。
 * repository 已按播放顺序排好，这里保持原序，数组下标即集数顺序。
 */
export function toDramaDetail(
  drama: DramaRow,
  buildCoverUrl: (coverPath: string) => string
): DramaDetail {
  return {
    ...toDramaSummary(drama, buildCoverUrl),
    videos: drama.videos.filter(isPlayable).map(toVideoItem),
  };
}
