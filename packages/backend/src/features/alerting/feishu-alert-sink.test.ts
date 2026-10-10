import { describe, expect, it, vi } from 'vitest';
import { FeishuAlertSink } from './feishu-alert-sink.js';
import { backoffMs } from './semantics.js';
import type { SafeAlertCard } from './safe-card.js';

const card: SafeAlertCard = {
  title: 'Alert',
  summary: 'safe summary',
  severity: 'P1',
  transition: 'firing',
  incident_fingerprint: 'test:logs:availability:all',
  notification_key: 'test:logs:availability:all:firing:x',
  metrics: [],
  samples: [],
};

describe('FeishuAlertSink', () => {
  it('honours Retry-After on 429 without reading a response body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '2' } }));
    const result = await new FeishuAlertSink('https://example.invalid/hook', fetchImpl).deliver(
      card,
      1000
    );
    expect(result).toEqual({ kind: 'retryable', errorClass: 'http_429', retryAfterMs: 2000 });
  });

  it('turns an abort timeout into a retryable safe class', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    await expect(
      new FeishuAlertSink('https://example.invalid/hook', fetchImpl).deliver(card, 1)
    ).resolves.toEqual({
      kind: 'retryable',
      errorClass: 'timeout',
    });
  });

  it('does not send when the configured endpoint is unsafe or missing', async () => {
    const fetchImpl = vi.fn();
    await expect(new FeishuAlertSink('', fetchImpl).deliver(card, 1)).resolves.toEqual({
      kind: 'permanent',
      errorClass: 'not_configured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses bounded retry delays and honours the server retry floor', () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(10)).toBe(60000);
    expect(backoffMs(1, 4000)).toBe(4000);
  });
});
