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
let inFlight = 0;

type Waiter = {
  rank: number;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const waiters: Waiter[] = [];

function wakeNext(): void {
  while (inFlight < maxInFlight && waiters.length > 0) {
    waiters.sort((a, b) => a.rank - b.rank);
    const next = waiters.shift();
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
    inFlight += 1;
    next.resolve();
  }
}

function acquire(priority: RequestPriority, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
    );
  }
  if (inFlight < maxInFlight) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      rank: PRIORITY_RANK[priority],
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

function release(): void {
  inFlight = Math.max(0, inFlight - 1);
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
    release();
  }
}

export function getRequestConcurrencyStats(): {
  inFlight: number;
  waiting: number;
  maxInFlight: number;
} {
  return { inFlight, waiting: waiters.length, maxInFlight };
}

/** 仅测试：恢复默认帽与空队列。 */
export function __resetRequestConcurrencyForTests(nextMax = 3): void {
  maxInFlight = nextMax;
  inFlight = 0;
  for (const waiter of waiters.splice(0, waiters.length)) {
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.reject(new Error('request concurrency reset'));
  }
}
