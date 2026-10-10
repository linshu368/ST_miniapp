import { describe, expect, it, vi } from 'vitest';
import { FeishuAlertSink, feishuInteractiveMessage } from './feishu-alert-sink.js';
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

  it('treats HTTP 200 with a Feishu business error as failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 11246, msg: 'parse card json err', data: {} }), {
        status: 200,
      })
    );
    await expect(
      new FeishuAlertSink('https://example.invalid/hook', fetchImpl).deliver(card, 1000)
    ).resolves.toEqual({ kind: 'permanent', errorClass: 'feishu_11246' });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toEqual(feishuInteractiveMessage(card));
    expect(body.card.header.title.tag).toBe('plain_text');
    expect(body.card.title).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/https?:\/\//);
  });

  it('accepts only Feishu code 0 on HTTP 200', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 })
      );
    await expect(
      new FeishuAlertSink('https://example.invalid/hook', fetchImpl).deliver(card, 1000)
    ).resolves.toEqual({ kind: 'succeeded' });
  });

  it('does not treat an unreadable HTTP 200 body as success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not-json', { status: 200 }));
    await expect(
      new FeishuAlertSink('https://example.invalid/hook', fetchImpl).deliver(card, 1000)
    ).resolves.toEqual({ kind: 'retryable', errorClass: 'invalid_body' });
  });

  it('does not send when the configured endpoint is unsafe or missing', async () => {
    const fetchImpl = vi.fn();
    await expect(new FeishuAlertSink('', fetchImpl).deliver(card, 1)).resolves.toEqual({
      kind: 'permanent',
      errorClass: 'not_configured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses a prepared P0 title and keeps detail lines', () => {
    const message = feishuInteractiveMessage({
      ...card,
      severity: 'P0',
      title: 'P0 同一用户5分钟内至少2单未支付成功',
      summary:
        'tg-id: 888001\n过去5分钟未成功支付: 2 单\n订单号: MA-1\n时间: 2026-10-10 17:59:00 +08:00',
    });
    expect(message.card.header.title.content).toBe('P0 同一用户5分钟内至少2单未支付成功');
    expect(message.card.elements[0]?.text.content).toContain('tg-id: 888001');
    expect(message.card.elements[0]?.text.content).toContain('\n订单号: MA-1');
    expect(message.card.elements[0]?.text.content).not.toContain('firing');
  });

  it('uses bounded retry delays and honours the server retry floor', () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(10)).toBe(60000);
    expect(backoffMs(1, 4000)).toBe(4000);
  });
});
