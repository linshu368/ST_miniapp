import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertEvaluationSchema, type AlertEvaluation } from '@miniapp/shared';
import { createSafeAlertCard } from '../alerting/safe-card.js';
import { classifyProviderAlert, LlmProviderAlertObserver } from './provider-alerts.js';

const log = {
  biz: { info: vi.fn() },
  sys: { warn: vi.fn() },
} as never;

describe('LlmProviderAlertObserver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [401, 'access_blocked'],
    [402, 'quota_exhausted'],
    [403, 'access_blocked'],
    [429, 'rate_limited'],
    [400, null],
    [500, null],
  ] as const)('classifies HTTP %s as %s', (status, expected) => {
    expect(classifyProviderAlert(status)).toBe(expected);
  });

  it('deduplicates a firing incident, recovers it, and permits a later firing', async () => {
    const evaluations: AlertEvaluation[] = [];
    const publish = vi.fn(async (input: unknown) => {
      evaluations.push(AlertEvaluationSchema.parse(input));
      return { kind: 'accepted' } as const;
    });
    const observer = new LlmProviderAlertObserver({ publish }, log, {
      environment: 'production',
    });
    const failure = {
      provider: 'venice' as const,
      model: 'venice-uncensored-1-2',
      status: 429,
    };

    observer.observe(failure);
    observer.observe(failure);
    await observer.flush();
    observer.observe({ ...failure, status: 200 });
    await observer.flush();
    observer.observe(failure);
    await observer.flush();

    expect(evaluations.map((item) => item.state)).toEqual(['firing', 'healthy', 'firing']);
    expect(new Set(evaluations.map((item) => item.fingerprint)).size).toBe(1);
    expect(evaluations[0]).toMatchObject({
      severity: 'P1',
      domain: 'generation',
      metrics: [
        { name: 'upstream_status', value: 429 },
        { name: 'observed_events', value: 1 },
      ],
      samples: [{ kind: 'model', reference: 'venice-uncensored-1-2' }],
    });
    expect(() =>
      createSafeAlertCard(evaluations[0]!, 'firing', 'generation-alert-test')
    ).not.toThrow();
  });

  it('groups balance and access incidents by provider but keeps model rate limits separate', async () => {
    const evaluations: AlertEvaluation[] = [];
    const observer = new LlmProviderAlertObserver(
      {
        publish: async (input) => {
          evaluations.push(AlertEvaluationSchema.parse(input));
          return { kind: 'accepted' };
        },
      },
      log,
      { environment: 'test' }
    );

    observer.observe({ provider: 'openrouter', model: 'vendor/model-a', status: 402 });
    observer.observe({ provider: 'openrouter', model: 'vendor/model-b', status: 402 });
    observer.observe({ provider: 'openrouter', model: 'vendor/model-a', status: 429 });
    observer.observe({ provider: 'openrouter', model: 'vendor/model-b', status: 429 });
    await observer.flush();

    expect(evaluations.filter((item) => item.rule_id.includes('quota'))).toHaveLength(1);
    expect(evaluations.filter((item) => item.rule_id.includes('rate-limited'))).toHaveLength(2);

    observer.observe({ provider: 'openrouter', model: 'vendor/model-a', status: 200 });
    await observer.flush();
    const recovered = evaluations.filter((item) => item.state === 'healthy');
    expect(recovered).toHaveLength(2);
    expect(recovered.map((item) => item.rule_id).sort()).toEqual([
      'provider-quota-exhausted',
      'provider-rate-limited',
    ]);
  });

  it('does not publish unrelated upstream failures or successes without an incident', async () => {
    const publish = vi.fn();
    const observer = new LlmProviderAlertObserver({ publish }, log, { environment: 'test' });

    observer.observe({ provider: 'venice', model: 'model-a', status: 400 });
    observer.observe({ provider: 'venice', model: 'model-a', status: 500 });
    observer.observe({ provider: 'venice', model: 'model-a', status: 200 });
    await observer.flush();

    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps Surplus incidents attributed to Surplus through publish and recovery', async () => {
    const evaluations: AlertEvaluation[] = [];
    const observer = new LlmProviderAlertObserver(
      {
        publish: async (input) => {
          evaluations.push(AlertEvaluationSchema.parse(input));
          return { kind: 'accepted' };
        },
      },
      log,
      { environment: 'test' }
    );

    observer.observe({ provider: 'surplus', model: 'anthropic/claude-haiku-5.5', status: 429 });
    await observer.flush();
    observer.observe({ provider: 'surplus', model: 'anthropic/claude-haiku-5.5', status: 200 });
    await observer.flush();

    expect(evaluations.map((item) => item.fingerprint)).toEqual([
      'test:generation:surplus:rate_limited:anthropic-claude-haiku-5-5',
      'test:generation:surplus:rate_limited:anthropic-claude-haiku-5-5',
    ]);
    expect(evaluations.map((item) => item.state)).toEqual(['firing', 'healthy']);
  });

  it('cools down a failed publish and retries only after a later response', async () => {
    let now = 1_000;
    const publish = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'failed', reason: 'persistence_failed' })
      .mockResolvedValue({ kind: 'accepted' });
    const observer = new LlmProviderAlertObserver({ publish }, log, {
      environment: 'test',
      now: () => now,
      retryCooldownMs: 1_000,
    });
    const failure = { provider: 'openrouter' as const, model: 'vendor/model', status: 402 };

    observer.observe(failure);
    await observer.flush();
    now += 999;
    observer.observe(failure);
    await observer.flush();
    expect(publish).toHaveBeenCalledTimes(1);

    now += 1;
    observer.observe(failure);
    await observer.flush();
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
