/**
 * 状态栏 AI（建卡、玩家工具箱共用）的闸门：同一用户同时只跑一个，两次之间至少 3 秒；
 * 全站最多 16 个并发（同 AI 润色）。拿到返回的 release，结束时（无论成败）调用。
 */
const MAX_ACTIVE = 16;
const MIN_GAP_MS = 3_000;
const MAX_TRACKED = 5_000;

const active = new Set<string>();
const recent = new Map<string, number>();

export function acquireStatusBarAi(userId: string, now = Date.now()): (() => void) | null {
  if (active.has(userId) || active.size >= MAX_ACTIVE) return null;
  if (now - (recent.get(userId) ?? 0) < MIN_GAP_MS) return null;
  if (recent.size >= MAX_TRACKED) {
    const oldest = recent.keys().next().value;
    if (oldest) recent.delete(oldest);
  }
  recent.delete(userId);
  recent.set(userId, now);
  active.add(userId);
  return () => {
    active.delete(userId);
  };
}
