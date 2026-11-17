import { API_URL } from './client';

const MIN_INTERVAL_MS = 25_000;
const TIMEOUT_MS = 5_000;

let lastStartedAt = Number.NEGATIVE_INFINITY;
let lastVerifiedAt: number | null = null;
let inFlight = false;

/** How long ago the connection was last proven to work; null when it never was. */
export function connectionVerifiedAgeMs(): number | null {
  return lastVerifiedAt === null ? null : performance.now() - lastVerifiedAt;
}

/**
 * Keeps the socket to the API origin alive so a send does not pay for a new handshake,
 * or discover a dead connection, after the user has already pressed the button.
 *
 * Deliberately outside apiClient: this carries no data, so it must not retry, report
 * failures or send custom headers. Default credentials share the chat POST's socket pool,
 * and /health touches no database.
 */
export function warmApiConnection(): boolean {
  const now = performance.now();
  if (inFlight || now - lastStartedAt < MIN_INTERVAL_MS) return false;
  inFlight = true;
  lastStartedAt = now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  void fetch(`${API_URL}/health`, { cache: 'no-store', signal: controller.signal })
    .then(() => {
      lastVerifiedAt = performance.now();
    })
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(timer);
      inFlight = false;
    });
  return true;
}

export function resetConnectionWarmthForTest(): void {
  lastStartedAt = Number.NEGATIVE_INFINITY;
  lastVerifiedAt = null;
  inFlight = false;
}
