/**
 * sync-engine / queue / retry.ts
 *
 * 指数退避重试策略。
 * 纯函数，不做 IO，方便测试。
 *
 * 退避公式：delay = BASE_DELAY_MS * 2^(attempt - 1)
 *   attempt=1 → 5s
 *   attempt=2 → 10s
 *   attempt=3 → 20s
 *   attempt=4 → 40s
 *   attempt=5 → 80s
 *   attempt>5 → 死信
 */

const BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export interface RetryDecision {
  /** true = 还有重试机会；false = 进入死信 */
  shouldRetry: boolean;
  /** 下次重试的绝对时间（shouldRetry=false 时为 null） */
  nextRetryAt: Date | null;
  /** 下次重试的延迟毫秒数（shouldRetry=false 时为 null） */
  delayMs: number | null;
}

/**
 * 根据当前已尝试次数决定是否重试以及下次重试时间。
 *
 * @param attempts    - 已执行次数（含本次失败，即本次失败后 attempts 已 +1）
 * @param maxAttempts - 最大尝试次数（默认 5）
 * @param now         - 当前时间（便于测试注入）
 */
export function computeRetry(
  attempts: number,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  now: Date = new Date()
): RetryDecision {
  if (attempts >= maxAttempts) {
    return { shouldRetry: false, nextRetryAt: null, delayMs: null };
  }

  const delayMs = BASE_DELAY_MS * Math.pow(2, attempts - 1);
  const nextRetryAt = new Date(now.getTime() + delayMs);

  return { shouldRetry: true, nextRetryAt, delayMs };
}
