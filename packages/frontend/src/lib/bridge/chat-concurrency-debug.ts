/**
 * [TEMP DEBUG — chat-integrity] Remote action trace for diagnosing overlapping ST chat mutations.
 *
 * Events are emitted by both BridgeClient (queued/sent/response/timeout) and the ST iframe
 * (handler start/end). They are posted immediately so an integrity popup or iframe reload does
 * not erase the evidence. Remove this file and its call sites after the dominant race is fixed.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://stminiapp-development.up.railway.app';

const parentSessionId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `parent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function getChatDebugParentSessionId(): string {
  return parentSessionId;
}

export function reportChatConcurrencyEvent(event: Record<string, unknown>): void {
  const payload = {
    ...event,
    parentSessionId,
    at: typeof event.at === 'number' ? event.at : Date.now(),
    ua: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  };

  try {
    // Keep a local copy for desktop/local reproduction.
    // eslint-disable-next-line no-console
    console.info('[chat-concurrency]', payload);
  } catch {
    /* noop */
  }

  try {
    void fetch(`${API_URL}/api/debug/chat-concurrency`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      /* fire-and-forget */
    });
  } catch {
    /* noop */
  }
}
