import { describe, expect, it, vi } from 'vitest';
import type { ObservationEvent } from './sdk.js';

vi.mock('pino', () => {
  throw new Error('SDK must not import Pino');
});
vi.mock('node:fs', () => {
  throw new Error('SDK must not import filesystem');
});
vi.mock('node:fs/promises', () => {
  throw new Error('SDK must not import async filesystem');
});
vi.mock('fastify', () => {
  throw new Error('SDK must not import a web framework');
});
vi.mock('@prisma/client', () => {
  throw new Error('SDK must not import Prisma');
});
vi.mock('@supabase/supabase-js', () => {
  throw new Error('SDK must not import Supabase');
});
vi.mock('@sentry/node', () => {
  throw new Error('SDK must not import Sentry');
});
vi.mock('../../features/alerting/feishu-alert-sink.js', () => {
  throw new Error('SDK must not import a delivery channel');
});
vi.mock('../config.js', () => {
  throw new Error('SDK must not bootstrap application config');
});
vi.mock('../runtime-config.js', () => {
  throw new Error('SDK must not import database config');
});
vi.mock('./runtime.js', () => {
  throw new Error('SDK must not import application singleton');
});
vi.mock('./labels.zh-CN.js', () => {
  throw new Error('SDK must not import project display dictionaries');
});

describe('SDK extraction boundary', () => {
  it('imports factories without application dependencies and preserves fetch results', async () => {
    const sdk = await import('./sdk.js');
    expect('observation' in sdk).toBe(false);
    expect('loadLogAlertPolicy' in sdk).toBe(false);
    const events: ObservationEvent[] = [];
    const observer = sdk.createObserver([
      (event) => {
        events.push(event);
      },
    ]);
    const fetch = sdk.createObservedFetch(observer);
    const response = new Response('fixture body');
    const execute = vi.fn(async () => response);
    expect(await fetch('fixture.request', 'https://example.invalid', undefined, {}, execute)).toBe(
      response
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(false);
    expect(events.at(-1)).toMatchObject({ outcome: 'succeeded', stage: 'response_headers' });
    expect(JSON.stringify(events)).not.toContain('fixture body');
  });

  it('isolates job reporters between injected instances and leaves unresolved results unknown', async () => {
    const sdk = await import('./sdk.js');
    const first: ObservationEvent[] = [],
      second: ObservationEvent[] = [];
    const a = sdk.createJobObservation(
      sdk.createObserver([
        (event) => {
          first.push(event);
        },
      ])
    );
    const b = sdk.createJobObservation(
      sdk.createObserver([
        (event) => {
          second.push(event);
        },
      ])
    );
    await a.runObservedJob('fixture', async () => {
      expect(a.hasBackgroundOperation('fixture')).toBe(true);
      expect(b.hasBackgroundOperation('fixture')).toBe(false);
      b.finishBackgroundOperation('fixture', { outcome: 'failed' });
      await b.runObservedJob('fixture', async () => {
        b.finishBackgroundOperation('fixture', { outcome: 'skipped', outcome_known: true });
      });
      a.finishBackgroundOperation('fixture', { outcome: 'succeeded', outcome_known: true });
    });
    expect(first.at(-1)?.outcome).toBe('succeeded');
    expect(second.at(-1)?.outcome).toBe('skipped');
    expect(first[0]?.trace_id).not.toBe(second[0]?.trace_id);
    expect(first.every((event) => event.call_scene === 'job.fixture')).toBe(true);
    expect(second.every((event) => event.call_scene === 'job.fixture')).toBe(true);
    await a.runObservedJob('unreported', async () => {});
    expect(first.at(-1)?.outcome).toBe('unknown');
    const err = new Error('fixture error');
    await expect(
      a.runObservedJob('failed', async () => {
        throw err;
      })
    ).rejects.toBe(err);
    expect(first.at(-1)?.outcome).toBe('failed');
  });

  it('uses an injected delivery interface and optional project presentation', async () => {
    const sdk = await import('./sdk.js');
    const sink = { deliver: vi.fn().mockResolvedValue({ kind: 'succeeded' }) };
    const alerts = sdk.createLogAlerts(
      { enabled: true, rules: sdk.parseLogAlertRules([{ id: 'fixture' }]) },
      sink,
      vi.fn(),
      { serviceName: 'Example', logLookupHint: 'Search the configured stdout collector.' }
    );
    alerts.accept({
      event_id: 'fixture-event',
      event: 'fixture.failed',
      operation: 'fixture',
      level: 50,
    });
    await alerts.close();
    expect(sink.deliver.mock.calls[0]?.[0]).toMatchObject({ title: 'Example fixture' });
    expect(sink.deliver.mock.calls[0]?.[0].summary).not.toMatch(/Backend|Railway|Feishu/);
  });

  it('injects a project-independent display catalog without importing application labels', async () => {
    const { createLogPresentation } = await import('./sdk.js');
    const display = createLogPresentation({
      modules: { api: 'API' },
      scenes: {},
      events: {},
      results: { succeeded: 'OK' },
      errors: {},
      details: {},
      counts: {},
      fallback: { module: 'System', scene: 'Event', result: 'Recorded', error: 'Error' },
    });
    expect(
      display({ module: 'api', event: 'example', outcome: 'succeeded', msg: 'private' })
    ).toMatchObject({ module_name: 'API', result: 'OK', scenario: 'example' });
  });
});
