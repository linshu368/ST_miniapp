import type { VideoItem } from '@miniapp/shared';

/**
 * 续播逻辑：videos 已按播放顺序排好，取当前集下标 + 1 的下一条 id。
 * 找不到当前集（未开始播放）或已经是最后一集时返回 null，调用方不再切 src。
 */
export function resolveNextVideoId(
  videos: VideoItem[],
  currentVideoId: string | null
): string | null {
  if (!currentVideoId) return null;
  const currentIndex = videos.findIndex((video) => video.id === currentVideoId);
  if (currentIndex < 0) return null;
  return videos[currentIndex + 1]?.id ?? null;
}
