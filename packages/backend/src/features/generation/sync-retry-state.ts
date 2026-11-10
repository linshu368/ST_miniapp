import type { ChatHistorySyncRow } from '../../infrastructure/repositories/ConversationHistoryRepository.js';

const NOT_READY_BACKOFF_BASE_MS = 30_000;
const NOT_READY_BACKOFF_MAX_MS = 4 * 60 * 1000;
const RETRY_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_STATE_LIMIT = 2_000;
interface RetryState {
  fingerprint: string;
  attempts: number;
  nextRetryAt: number;
  firstSeenAt: number;
}
export const syncRetryStates = new Map<string, RetryState>();

export async function runSettledWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<Array<PromiseSettledResult<T>>> {
  const limit = Math.max(1, Math.min(concurrency, tasks.length));
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (!task) continue;
      try {
        results[index] = { status: 'fulfilled', value: await task() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function syncRecordFingerprint(record: ChatHistorySyncRow): string {
  return [
    record.callProvider ?? '',
    record.generationId ?? '',
    record.status,
    record.llm_finish_reason ?? '',
    record.llm_charge_id ?? '',
    record.llm_billing_settled_at ?? '',
  ].join('\u001f');
}

export function shouldDeferRecord(record: ChatHistorySyncRow, now: number): boolean {
  const state = syncRetryStates.get(record.id);
  if (!state) return false;
  if (now - state.firstSeenAt >= RETRY_STATE_TTL_MS) {
    syncRetryStates.delete(record.id);
    return false;
  }
  if (state.fingerprint !== syncRecordFingerprint(record)) {
    syncRetryStates.delete(record.id);
    return false;
  }
  return now < state.nextRetryAt;
}

export function registerRetryState(record: ChatHistorySyncRow, now: number): void {
  const fingerprint = syncRecordFingerprint(record);
  const previous = syncRetryStates.get(record.id);
  const attempts = previous?.fingerprint === fingerprint ? previous.attempts + 1 : 0;
  const delayMs = Math.min(NOT_READY_BACKOFF_BASE_MS * 2 ** attempts, NOT_READY_BACKOFF_MAX_MS);

  pruneRetryStates(now);
  if (!syncRetryStates.has(record.id) && syncRetryStates.size >= RETRY_STATE_LIMIT) {
    let oldestId: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, state] of syncRetryStates) {
      if (state.firstSeenAt < oldestAt) {
        oldestId = id;
        oldestAt = state.firstSeenAt;
      }
    }
    if (oldestId) syncRetryStates.delete(oldestId);
  }

  syncRetryStates.set(record.id, {
    fingerprint,
    attempts,
    nextRetryAt: now + delayMs,
    firstSeenAt: previous?.fingerprint === fingerprint ? previous.firstSeenAt : now,
  });
}

export function pruneRetryStates(now: number): void {
  for (const [id, state] of syncRetryStates) {
    if (now - state.firstSeenAt >= RETRY_STATE_TTL_MS) syncRetryStates.delete(id);
  }
}
