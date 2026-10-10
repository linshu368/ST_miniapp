import type { SafeAlertCard } from './safe-card.js';

export type FeishuDeliveryResult =
  | { kind: 'succeeded' }
  | { kind: 'retryable'; retryAfterMs?: number; errorClass: string }
  | { kind: 'permanent'; errorClass: string };

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.round(seconds * 1_000), 60_000);
}

/** The sole Feishu HTTP adapter. It deliberately never logs URL, response body, or card content. */
export class FeishuAlertSink {
  constructor(
    private readonly webhookUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  configured(): boolean {
    try {
      const url = new URL(this.webhookUrl);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  async deliver(card: SafeAlertCard, timeoutMs: number): Promise<FeishuDeliveryResult> {
    if (!this.configured()) return { kind: 'permanent', errorClass: 'not_configured' };
    try {
      const response = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg_type: 'interactive', card }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return { kind: 'succeeded' };
      if (response.status === 429 || response.status >= 500) {
        return {
          kind: 'retryable',
          errorClass: `http_${response.status}`,
          retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
        };
      }
      return { kind: 'permanent', errorClass: `http_${response.status}` };
    } catch (err) {
      return {
        kind: 'retryable',
        errorClass:
          err instanceof DOMException && err.name === 'TimeoutError' ? 'timeout' : 'transport',
      };
    }
  }
}
