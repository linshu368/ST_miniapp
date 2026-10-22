/**
 * 在途请求登记：卡住时回答「当时在等哪些请求、等了多久」。
 * 只存路由模板和时间，不存 URL/参数/body。
 */
export interface InflightRequest {
  requestId: string;
  route: string;
  startedAt: number;
}

export interface SettledRequest {
  route: string;
  durationMs: number;
  slow: boolean;
  outcome: string;
}

const inflight = new Map<string, InflightRequest>();
const observers = new Set<(settled: SettledRequest) => void>();

export function trackRequestStart(requestId: string, route: string): void {
  inflight.set(requestId, { requestId, route, startedAt: performance.now() });
}

export function trackRequestEnd(requestId: string): void {
  inflight.delete(requestId);
}

export function snapshotInflight(): Array<{ route: string; waitedMs: number }> {
  const now = performance.now();
  return Array.from(inflight.values()).map((r) => ({
    route: r.route,
    waitedMs: Math.round(now - r.startedAt),
  }));
}

/** 页面追踪器订阅它统计「进页后 10 秒内的请求数/慢请求数」。返回取消订阅函数。 */
export function observeSettledRequests(listener: (settled: SettledRequest) => void): () => void {
  observers.add(listener);
  return () => observers.delete(listener);
}

export function notifySettled(settled: SettledRequest): void {
  for (const listener of observers) {
    try {
      listener(settled);
    } catch {
      // 观察者出错不能影响请求路径。
    }
  }
}
