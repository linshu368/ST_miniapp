import { setTimeout as delay } from 'node:timers/promises';

interface ReadFailure {
  message: string;
  code?: string;
  details?: string;
}

// A SQL timeout, unclassified AbortError or HTTP 500 is not evidence of a
// transient transport fault. Retrying those amplifies the slow-query incident.
function transientTransport(error: ReadFailure): boolean {
  return (
    !error.code &&
    /ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT/.test(
      `${error.message} ${error.details ?? ''}`
    )
  );
}

export async function readConversationPage<T>(
  read: (signal: AbortSignal) => PromiseLike<{ data: T | null; error: ReadFailure | null }>,
  external?: AbortSignal
): Promise<{ data: T; attempts: number; elapsedMs: number }> {
  const started = performance.now();
  for (let attempt = 1; attempt <= 2; attempt++) {
    external?.throwIfAborted();
    const remaining = 8_000 - (performance.now() - started);
    if (remaining <= 0) throw new Error('查询会话消息失败：读取预算已耗尽');
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(5_000, remaining))));
    const signal = external ? AbortSignal.any([timeout, external]) : timeout;
    const result = await read(signal);
    // PostgREST serializes a fetch cancellation into its error envelope. Do not
    // let a coincident disconnect hide an unrelated database/SDK failure.
    if (
      external?.aborted &&
      (!result.error ||
        (!result.error.code &&
          external.reason instanceof Error &&
          result.error.message === `${external.reason.name}: ${external.reason.message}`))
    )
      external.throwIfAborted();
    if (!result.error) {
      if (result.data === null) throw new Error('查询会话消息失败：返回数据缺失');
      return { data: result.data, attempts: attempt, elapsedMs: performance.now() - started };
    }
    if (
      attempt === 2 ||
      external?.aborted ||
      timeout.aborted ||
      !transientTransport(result.error)
    ) {
      throw new Error('查询会话消息失败', { cause: result.error });
    }
    try {
      await delay(100 + Math.floor(Math.random() * 151), undefined, { signal: external });
    } catch (error) {
      // Node timers wrap the caller reason in AbortError.cause. Normalize only
      // that exact wrapper so the route can prove which request cancelled it.
      if (
        external?.aborted &&
        error instanceof Error &&
        error.name === 'AbortError' &&
        error.cause === external.reason
      )
        external.throwIfAborted();
      throw error;
    }
  }
  throw new Error('查询会话消息失败');
}
