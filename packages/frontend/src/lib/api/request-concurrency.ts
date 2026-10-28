/**
 * 浏览器端短请求并发帽：压低入场齐射，critical 插队，长耗时接口绕过。
 * 只限制「同时 in-flight」；排队等待不占槽，避免重试退避占死名额。
 */

export type RequestPriority = 'critical' | 'normal' | 'background';

const PRIORITY_RANK: Record<RequestPriority, number> = {
  critical: 0,
  normal: 1,
  background: 2,
};

/** Telegram WebView 下同主机并行连接有限；3 兼顾吞吐与边缘排队。 */
let maxInFlight = 3;
let inFlightCritical = 0;
let inFlightNonCritical = 0;

type Waiter = {
  priority: RequestPriority;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const waiters: Waiter[] = [];

function totalInFlight(): number {
  return inFlightCritical + inFlightNonCritical;
}

function canAcquire(priority: RequestPriority): boolean {
  if (priority === 'critical') return totalInFlight() < maxInFlight;
  // Keep one connection available for navigation/playback work. A test or
  // constrained WebView configured with a single slot must still make progress.
  const nonCriticalLimit = maxInFlight > 1 ? maxInFlight - 1 : 1;
  return totalInFlight() < nonCriticalLimit;
}

function markAcquired(priority: RequestPriority): void {
  if (priority === 'critical') inFlightCritical += 1;
  else inFlightNonCritical += 1;
}

function wakeNext(): void {
  while (totalInFlight() < maxInFlight && waiters.length > 0) {
    waiters.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    const nextIndex = waiters.findIndex((waiter) => canAcquire(waiter.priority));
    if (nextIndex < 0) return;
    const [next] = waiters.splice(nextIndex, 1);
    if (!next) return;
    if (next.signal?.aborted) {
      next.reject(
        next.signal.reason instanceof Error
          ? next.signal.reason
          : new DOMException('Aborted', 'AbortError')
      );
      continue;
    }
    if (next.onAbort && next.signal) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    markAcquired(next.priority);
    next.resolve();
  }
}

function acquire(priority: RequestPriority, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
    );
  }
  if (canAcquire(priority)) {
    markAcquired(priority);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      priority,
      resolve,
      reject,
      signal,
    };
    const onAbort = () => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(
        signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
      );
    };
    waiter.onAbort = onAbort;
    waiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function release(priority: RequestPriority): void {
  if (priority === 'critical') inFlightCritical = Math.max(0, inFlightCritical - 1);
  else inFlightNonCritical = Math.max(0, inFlightNonCritical - 1);
  wakeNext();
}

/**
 * 占用一个短请求槽后执行；`bypass` 不排队（生成/上传等长耗时）。
 * 调用方 abort 时若仍在排队则直接失败且不占槽。
 */
export async function withRequestSlot<T>(
  priority: RequestPriority | 'bypass',
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  if (priority === 'bypass') return run();
  await acquire(priority, signal);
  try {
    return await run();
  } finally {
    release(priority);
  }
}

export function getRequestConcurrencyStats(): {
  inFlight: number;
  waiting: number;
  maxInFlight: number;
} {
  return { inFlight: totalInFlight(), waiting: waiters.length, maxInFlight };
}

/** 仅测试：恢复默认帽与空队列。 */
export function __resetRequestConcurrencyForTests(nextMax = 3): void {
  maxInFlight = nextMax;
  inFlightCritical = 0;
  inFlightNonCritical = 0;
  for (const waiter of waiters.splice(0, waiters.length)) {
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.reject(new Error('request concurrency reset'));
  }
}
