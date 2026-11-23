import type { ConversationHistoryRepository } from '../../infrastructure/repositories/ConversationHistoryRepository.js';

/** Ephemeral progress, not a lease: restart safely revisits rows through existing DB guards. */
let after: { createdAt: string; id: string } | undefined;

export function resetStaleStreamingScan(): void {
  after = undefined;
}

export async function scanStaleStreaming(history: ConversationHistoryRepository, limit: number) {
  const rows = await history.listStaleStreaming({ limit, ...(after ? { after } : {}) });
  const last = rows.at(-1);
  // Advance over failures too; an empty/short scan wraps and retries them next sweep.
  after =
    last?.created_at && rows.length >= limit
      ? { createdAt: last.created_at, id: last.id }
      : undefined;
  return rows;
}
