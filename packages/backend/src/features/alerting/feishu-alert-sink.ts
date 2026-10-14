import type { SafeAlertCard } from './safe-card.js';

export type FeishuDeliveryResult =
  | { kind: 'succeeded' }
  | { kind: 'retryable'; retryAfterMs?: number; errorClass: string }
  | { kind: 'permanent'; errorClass: string };

/** Documented custom-bot failures that retrying the same request cannot clear. */
const PERMANENT_FEISHU_CODES = new Set([
  9499, // malformed request
  11246, // card JSON rejected
  19021, // signature
  19022, // IP allowlist
  19024, // keyword
]);

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.round(seconds * 1_000), 60_000);
}

function clip(value: string, max: number, preserveLines = false): string {
  const text = (
    preserveLines ? value.replace(/[^\S\n]+/g, ' ') : value.replace(/\s+/g, ' ')
  ).trim();
  if (text.length <= max) return text || '-';
  return `${text.slice(0, max - 1)}…`;
}

function templateFor(card: SafeAlertCard): 'red' | 'orange' | 'yellow' | 'green' {
  if (card.transition === 'recovered') return 'green';
  if (card.severity === 'P0') return 'red';
  if (card.severity === 'P2') return 'yellow';
  return 'orange';
}

function headerTitle(card: SafeAlertCard): string {
  if (card.title.startsWith(`${card.severity} `)) return clip(card.title, 100);
  return clip(`${card.severity} ${card.transition} ${card.title}`, 100);
}

function cardText(card: SafeAlertCard): string {
  if (card.summary !== '支付监控规则满足触发条件' && card.summary !== '支付监控窗口健康') {
    return card.summary;
  }
  const lines = [
    card.summary,
    `fingerprint: ${card.incident_fingerprint}`,
    `notification: ${card.notification_key}`,
  ];
  for (const metric of card.metrics) {
    lines.push(`${metric.name}: ${metric.value}${metric.unit ? ` ${metric.unit}` : ''}`);
  }
  for (const sample of card.samples) {
    lines.push(`${sample.kind}: ${sample.reference}${sample.summary ? ` ${sample.summary}` : ''}`);
  }
  if (card.recommended_action) lines.push(card.recommended_action);
  return lines.join('\n');
}

/** Maps the safe envelope onto the custom-bot interactive card schema. */
export function feishuInteractiveMessage(card: SafeAlertCard): {
  msg_type: 'interactive';
  card: {
    header: {
      template: 'red' | 'orange' | 'yellow' | 'green';
      title: { tag: 'plain_text'; content: string };
    };
    elements: Array<{ tag: 'div'; text: { tag: 'plain_text'; content: string } }>;
  };
} {
  return {
    msg_type: 'interactive',
    card: {
      header: {
        template: templateFor(card),
        title: {
          tag: 'plain_text',
          content: headerTitle(card),
        },
      },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: clip(cardText(card), 1500, true) } },
      ],
    },
  };
}

/**
 * Custom-bot business failures still use HTTP 200. `code === 0` is the only success
 * signal; the legacy StatusCode field is intentionally ignored.
 */
function interpretFeishuBody(raw: string): FeishuDeliveryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'retryable', errorClass: 'invalid_body' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'retryable', errorClass: 'invalid_body' };
  }
  const code = (parsed as { code?: unknown }).code;
  if (code === 0) return { kind: 'succeeded' };
  if (typeof code === 'number' && Number.isInteger(code) && code > 0 && code < 1_000_000) {
    return {
      kind: PERMANENT_FEISHU_CODES.has(code) ? 'permanent' : 'retryable',
      errorClass: `feishu_${code}`,
    };
  }
  return { kind: 'retryable', errorClass: 'invalid_body' };
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
        body: JSON.stringify(feishuInteractiveMessage(card)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429 || response.status >= 500) {
        return {
          kind: 'retryable',
          errorClass: `http_${response.status}`,
          retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
        };
      }
      if (!response.ok) return { kind: 'permanent', errorClass: `http_${response.status}` };
      return interpretFeishuBody(await response.text());
    } catch (err) {
      return {
        kind: 'retryable',
        errorClass:
          err instanceof DOMException && err.name === 'TimeoutError' ? 'timeout' : 'transport',
      };
    }
  }
}
