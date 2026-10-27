import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DramaTimingReportSchema } from '@miniapp/shared';
import { railwayDramaReport } from '../scripts/import-drama-timing.js';

const wallets = {
  hasCompletedPayment: vi.fn(async () => false),
};
const timingLogs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const persistence = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/logger.js', () => ({
  requestLogger: () => ({
    biz: { info: timingLogs.info, warn: timingLogs.warn },
    sys: { error: timingLogs.error },
  }),
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabaseClient: () => ({ schema: () => ({}) }),
  getDomainDb: () => ({ rpc: persistence.rpc }),
}));

vi.mock('../lib/user.js', () => ({
  getOrCreateDbUserRecord: vi.fn(async () => ({
    id: '00000000-0000-0000-0000-000000000099',
    tg_id: '99999',
    total_round: 12,
  })),
}));

vi.mock('../infrastructure/repositories/MiniappWalletRepository.js', () => ({
  MiniappWalletRepository: class {
    constructor() {
      return wallets;
    }
  },
}));

async function buildApp() {
  const { default: telemetryRoutes } = await import('./telemetry.js');
  const app = Fastify({ logger: false });
  await app.register(telemetryRoutes);
  await app.ready();
  return app;
}

describe('GET /api/telemetry/replay-context', () => {
  beforeEach(() => {
    wallets.hasCompletedPayment.mockReset();
    wallets.hasCompletedPayment.mockResolvedValue(true);
    vi.stubEnv('DEV_AUTH_BYPASS', '');
    vi.stubEnv('MOCK_AUTH', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects missing Telegram auth', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/telemetry/replay-context',
      });
      expect(response.statusCode).toBe(401);
      const body = response.json() as { success: boolean };
      expect(body.success).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns only GetReplayContextData for an authenticated user', async () => {
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/telemetry/replay-context',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        success: boolean;
        data: Record<string, unknown>;
      };
      expect(body).toEqual({
        success: true,
        data: {
          telegram_user_id: '99999',
          is_paid_user: true,
          total_chat_rounds: 12,
        },
      });
      expect(body.data).not.toHaveProperty('user_id');
      expect(body.data).not.toHaveProperty('user_cohort');
      expect(body.data).not.toHaveProperty('id');
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/telemetry/drama-timing', () => {
  const report = {
    type: 'playback',
    phase: 'final',
    id: 'observation-id',
    outcome: 'playing',
    elapsedMs: 1234,
    marks: { first_frame: 1234 },
    stages: { source_to_frame: 234 },
    queries: [
      {
        kind: 'playback',
        startMs: -10,
        durationMs: 500,
        outcome: 'ok',
        attempts: [
          {
            requestId: 'play-request',
            startMs: -10,
            queueMs: 2,
            headersMs: 400,
            bodyMs: 98,
            totalMs: 500,
            outcome: 'ok',
            status: 200,
          },
        ],
      },
    ],
  };
  it('imports a sanitized Railway envelope and refuses invalid playback fields', () => {
    const parsed = railwayDramaReport({
      timestamp: '2026-10-27T10:00:00Z',
      attributes: [
        { key: 'event', value: '"drama.frontend_timing"' },
        ...Object.entries({
          type: 'playback',
          phase: 'final',
          observation_id: 'sample',
          outcome: 'playing',
          elapsed_ms: 100,
          marks: {},
          queries: [],
          token: 'must-not-store',
        }).map(([key, value]) => ({ key, value: JSON.stringify(value) })),
      ],
    });
    expect(parsed?.report.id).toBe('sample');
    expect(parsed?.receivedAt).toBe('2026-10-27T10:00:00.000Z');
    expect(JSON.stringify(parsed)).not.toContain('must-not-store');
    expect(() =>
      railwayDramaReport({
        event: 'drama.frontend_timing',
        type: 'playback',
        marks: { url: 'secret' },
      })
    ).toThrow();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    vi.stubEnv('MOCK_AUTH', '');
    vi.stubEnv('DRAMA_TIMING_PERSIST_ENABLED', 'false');
    persistence.rpc.mockReturnValue({ abortSignal: async () => ({ data: 'stored', error: null }) });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('rejects missing authentication before accepting frontend logs', async () => {
    vi.stubEnv('DEV_AUTH_BYPASS', '');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/telemetry/drama-timing',
        payload: report,
      });
      expect(response.statusCode).toBe(401);
      expect(timingLogs.info).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('writes client timings and original API request IDs without touching the database', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/telemetry/drama-timing',
        payload: report,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, data: { accepted: true } });
      expect(timingLogs.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'drama.frontend_timing',
          source: 'frontend',
          observation_id: 'observation-id',
          elapsed_ms: 1234,
          request_ids: ['play-request'],
          queries: report.queries,
        }),
        'drama frontend timing'
      );
      expect(wallets.hasCompletedPayment).not.toHaveBeenCalled();
      const slow = await app.inject({
        method: 'POST',
        url: '/api/telemetry/drama-timing',
        payload: { ...report, phase: 'slow', outcome: 'waiting' },
      });
      expect(slow.statusCode).toBe(200);
      expect(timingLogs.warn).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('acknowledges opt-in analytics only after storage and preserves the legacy logging mode', async () => {
    vi.stubEnv('DRAMA_TIMING_PERSIST_ENABLED', 'true');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/telemetry/drama-timing',
        payload: report,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, data: { accepted: true, persisted: true } });
      expect(persistence.rpc).toHaveBeenCalledWith(
        'record_drama_playback_observation',
        expect.objectContaining({
          p_environment: 'test',
          p_report: report,
          p_source: 'live',
        })
      );
    } finally {
      await app.close();
    }
  });

  it('reports storage errors without claiming durability or writing raw payloads to error logs', async () => {
    vi.stubEnv('DRAMA_TIMING_PERSIST_ENABLED', 'true');
    persistence.rpc.mockReturnValue({
      abortSignal: async () => ({ data: null, error: { code: 'db_unavailable' } }),
    });
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/telemetry/drama-timing',
        payload: report,
      });
      expect(response.statusCode).toBe(503);
      expect(timingLogs.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'drama.timing_persist_failed' }),
        expect.any(String)
      );
    } finally {
      await app.close();
    }
  });

  it('bounds concurrent telemetry writes and rejects overload instead of accumulating a queue', async () => {
    const { DramaTimingRepository, DramaTimingBusyError } =
      await import('../features/drama/timing-repository.js');
    const pending: Array<(result: { data: string; error: null }) => void> = [];
    persistence.rpc.mockReturnValue({
      abortSignal: () => new Promise((resolve) => pending.push(resolve)),
    });
    const repository = new DramaTimingRepository();
    const context = { environment: 'test', release: 'test' };
    const a = repository.persist(DramaTimingReportSchema.parse(report), context);
    const b = repository.persist(DramaTimingReportSchema.parse(report), context);
    await expect(
      repository.persist(DramaTimingReportSchema.parse(report), context)
    ).rejects.toBeInstanceOf(DramaTimingBusyError);
    for (const resolve of pending) resolve({ data: 'stored', error: null });
    await expect(Promise.all([a, b])).resolves.toEqual(['stored', 'stored']);
  });

  it('accepts media diagnostics through the existing log mapper and rejects unknown nested fields', async () => {
    const app = await buildApp();
    const state = {
      readyState: 1,
      networkState: 2,
      paused: true,
      muted: false,
      seeking: false,
      currentTimeMs: 0,
      bufferedAheadMs: 0,
      visibility: 'hidden',
    };
    const media = {
      events: [{ name: 'waiting', atMs: 500, state }],
      eventsTruncated: false,
      snapshot: state,
    };
    try {
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/telemetry/drama-timing',
        payload: { ...report, media },
      });
      expect(accepted.statusCode).toBe(200);
      expect(timingLogs.info).toHaveBeenCalledWith(
        expect.objectContaining({ media }),
        'drama frontend timing'
      );
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/telemetry/drama-timing',
        payload: { ...report, media: { ...media, snapshot: { ...state, play_url: 'private' } } },
      });
      expect(rejected.statusCode).toBe(400);
      expect(timingLogs.info).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('rejects unknown or credential-bearing fields, invalid durations, and oversized bodies', async () => {
    const app = await buildApp();
    try {
      for (const payload of [
        { ...report, play_url: 'https://example.invalid/private' },
        { ...report, queries: [{ ...report.queries[0], token: 'private' }] },
        { ...report, elapsedMs: -1 },
        { ...report, stages: { unexpected: 5 } },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/telemetry/drama-timing',
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
      const oversized = await app.inject({
        method: 'POST',
        url: '/api/telemetry/drama-timing',
        payload: { ...report, extra: 'x'.repeat(33_000) },
      });
      expect(oversized.statusCode).toBe(413);
      expect(timingLogs.info).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('bounds upload frequency per authenticated user and accepts the next window', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const app = await buildApp();
    try {
      for (let i = 0; i < 120; i += 1) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/telemetry/drama-timing',
              payload: report,
            })
          ).statusCode
        ).toBe(200);
      }
      const limited = await app.inject({
        method: 'POST',
        url: '/api/telemetry/drama-timing',
        payload: report,
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBe('60');
      now = 60_001;
      expect(
        (await app.inject({ method: 'POST', url: '/api/telemetry/drama-timing', payload: report }))
          .statusCode
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('does not acknowledge acceptance when the log sink fails', async () => {
    timingLogs.info.mockImplementationOnce(() => {
      throw new Error('log sink failed');
    });
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/telemetry/drama-timing',
        payload: report,
      });
      expect(response.statusCode).toBe(503);
      expect(timingLogs.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'drama.timing_log_failed',
          err: expect.any(Error),
        }),
        expect.any(String)
      );
    } finally {
      await app.close();
    }
  });
});
