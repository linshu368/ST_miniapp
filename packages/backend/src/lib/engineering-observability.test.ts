import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  engineeringRoute,
  observeGenerationAttempt,
  observeGenerationDispatch,
  observeGenerationTerminal,
  observeHttp,
  startEngineeringTelemetry,
} from './engineering-observability.js';

type Received = { path: string; body: Record<string, unknown> };
type MetricsPayload = {
  resourceMetrics: Array<{
    scopeMetrics: Array<{
      metrics: Array<{
        name: string;
        unit: string;
        histogram?: { dataPoints: Array<{ sum: number }> };
      }>;
    }>;
  }>;
};
let server: Server | undefined;
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function receiver(logStatus = 200) {
  const received: Received[] = [];
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ path: request.url!, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(request.url === '/v1/logs' ? logStatus : 200, {
      'content-type': 'application/json',
    });
    response.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test receiver address');
  return { endpoint: `http://127.0.0.1:${address.port}`, received };
}

const options = { enabled: true, environment: 'test', version: 'safe-test-release' };

describe('engineering telemetry boundary', () => {
  it('does not connect when disabled and rejects raw URL/identifier route labels', async () => {
    const sink = await receiver();
    stop = startEngineeringTelemetry({ ...options, enabled: false, endpoint: sink.endpoint });
    observeGenerationTerminal({
      provider: 'openrouter',
      model: 'safe-model',
      stream: true,
      outcome: 'success',
      durationMs: 10,
    });
    await stop();
    expect(sink.received).toEqual([]);
    expect(engineeringRoute('/api/dramas/:id/play')).toBe('/api/dramas/:id/play');
    expect(engineeringRoute('/api/dramas/11111111-1111-4111-8111-111111111111')).toBe('unknown');
    expect(engineeringRoute('/api/dramas?token=secret')).toBe('unknown');
    expect(engineeringRoute('https://private.example/api/dramas')).toBe('unmatched');
  });

  it('uses real OTLP JSON with safe projection, seconds and one shared provider', async () => {
    const sink = await receiver();
    stop = startEngineeringTelemetry({ ...options, endpoint: sink.endpoint });
    const secondStop = startEngineeringTelemetry({ ...options, endpoint: sink.endpoint });
    observeHttp({
      route: '/api/dramas/:id/play',
      method: 'GET',
      statusClass: '2xx',
      kind: 'standard',
      durationMs: 2_500,
    });
    observeGenerationDispatch({
      provider: 'untrusted-provider',
      model: 'safe-model',
      role: 'primary',
    });
    const unsafe = {
      provider: 'venice',
      model: 'safe-model',
      role: 'fallback' as const,
      outcome: 'first_token_observed' as const,
      durationMs: 100,
      dispatched: true,
      content: 'PRIVATE_CHAT_BODY',
      reasoning: 'PRIVATE_REASONING',
      generation_id: 'PRIVATE_GENERATION_ID',
    };
    observeGenerationAttempt(unsafe);
    await secondStop();
    // 一份 app 关闭不能停止仍被另一个 app 使用的进程级 provider。
    observeGenerationTerminal({
      provider: 'venice',
      model: 'safe-model',
      stream: true,
      outcome: 'filtered',
      durationMs: 300,
    });
    await stop();
    const wire = JSON.stringify(sink.received);
    expect(wire).not.toMatch(/PRIVATE_|untrusted-provider/);
    expect(wire).toContain('generation.attempt_terminal');
    expect(wire).toContain('first_token_observed');
    expect(wire).toContain('filtered');
    expect(wire).toContain('st-miniapp-backend');
    expect(sink.received.some((r) => r.path === '/v1/logs')).toBe(true);
    const metrics = sink.received.filter((r) => r.path === '/v1/metrics');
    expect(metrics).toHaveLength(1);
    const emitted = (metrics[0]!.body as unknown as MetricsPayload).resourceMetrics.flatMap((r) =>
      r.scopeMetrics.flatMap((s) => s.metrics)
    );
    const duration = emitted.find((m) => m.name === 'st_http_server_duration');
    expect(duration?.unit).toBe('s');
    expect(duration?.histogram?.dataPoints[0]?.sum).toBe(2.5);
  });

  it('bounds a burst queue and isolates rejected log exports from callers', async () => {
    const sink = await receiver(401);
    stop = startEngineeringTelemetry({ ...options, endpoint: sink.endpoint });
    for (let i = 0; i < 600; i++) {
      expect(() =>
        observeGenerationTerminal({
          provider: 'openrouter',
          model: 'safe-model',
          stream: true,
          outcome: 'success',
          durationMs: 10,
        })
      ).not.toThrow();
    }
    await vi.waitFor(() => expect(sink.received.some((r) => r.path === '/v1/logs')).toBe(true));
    // 首批401响应在关闭采集 metric 之前收口，发送失败和队列溢出是两个计数。
    await vi.waitFor(
      () => expect(sink.received.filter((r) => r.path === '/v1/logs').length).toBeGreaterThan(1),
      { timeout: 3_000 }
    );
    const startedAt = performance.now();
    await stop();
    expect(performance.now() - startedAt).toBeLessThan(2_750);
    const wire = JSON.stringify(sink.received.filter((r) => r.path === '/v1/metrics'));
    expect(wire).toContain('st_telemetry_failures');
    expect(wire).toContain('logDropped');
    expect(wire).toContain('logFailed');
    const countLogs = sink.received
      .filter((r) => r.path === '/v1/logs')
      .reduce(
        (sum, r) =>
          sum + (JSON.stringify(r.body).match(/"eventName":"generation.terminal"/g)?.length ?? 0),
        0
      );
    expect(countLogs).toBeGreaterThan(0);
    expect(countLogs).toBeLessThanOrEqual(320); // 256 queued + at most one 64-record in-flight batch.
  });
});
