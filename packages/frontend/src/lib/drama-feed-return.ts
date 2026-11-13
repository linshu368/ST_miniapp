// 从放映返回剧场时要找回的剧。只在本页面会话内存里：刷新或冷启动不该把列表拽到旧位置。
let feedReturnId: string | null = null;

export function rememberFeedReturn(id: string | null): void {
  feedReturnId = id;
}

/** 只读不清：严格模式会重复执行 state 初始化，清空放在 effect 里。 */
export function peekFeedReturn(): string | null {
  return feedReturnId;
}

export function clearFeedReturn(): void {
  feedReturnId = null;
}
