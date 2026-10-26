import type { VideoItem } from '@miniapp/shared';

/** 位移使用“结束点 - 起点”：手指上移为下一部，下移为上一部。 */
export function resolveDramaSwipeDirection(dx: number, dy: number): -1 | 1 | null {
  if (Math.abs(dy) < 64 || Math.abs(dy) <= Math.abs(dx) * 1.3) return null;
  return dy < 0 ? 1 : -1;
}

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
