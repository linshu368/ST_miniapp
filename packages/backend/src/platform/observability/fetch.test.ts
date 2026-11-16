import { describe, expect, it, vi } from 'vitest';
import { createObserver } from './core.js';
import { createObservedFetch } from './fetch.js';
import type { ObservationEvent } from './events.js';

describe('observed transport boundary', () => {
  it.each([200, 401, 429, 503])(
    'preserves %s response, headers, signal and unread body without retry',
    async (status) => {
      const events: ObservationEvent[] = [];
      const observe = createObservedFetch(
        createObserver([
          (event) => {
            events.push(event);
          },
        ])
      );
      const response = new Response('private-body', { status });
      const execute = vi.fn<typeof fetch>().mockResolvedValue(response);
      const input = 'https://example.invalid/private?token=private-secret';
      const init = {
        method: 'POST',
        body: 'private-body',
        headers: { authorization: 'private-secret' },
        signal: new AbortController().signal,
      };
      expect(await observe('provider.request', input, init, { provider: 'example' }, execute)).toBe(
        response
      );
      expect(execute).toHaveBeenCalledExactlyOnceWith(input, init);
      expect(response.bodyUsed).toBe(false);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        upstream_status: status,
        stage: 'response_headers',
        outcome: status === 200 ? 'succeeded' : 'failed',
      });
      expect(JSON.stringify(events)).not.toContain('private-');
    }
  );

  it.each(['TimeoutError', 'AbortError'])(
    'preserves rejection and classifies %s without retrying writes',
    async (name) => {
      const events: ObservationEvent[] = [];
      const observe = createObservedFetch(
        createObserver([
          (event) => {
            events.push(event);
          },
        ])
      );
      const error = new DOMException('private-secret', name);
      const controller = new AbortController();
      controller.abort(error);
      const execute = vi.fn<typeof fetch>().mockRejectedValue(error);
      await expect(
        observe(
          'payment.create',
          'https://example.invalid',
          { method: 'POST', signal: controller.signal },
          {},
          execute
        )
      ).rejects.toBe(error);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(events[1]).toMatchObject({
        outcome: name === 'TimeoutError' ? 'timed_out' : 'cancelled',
        outcome_known: false,
      });
      expect(JSON.stringify(events)).not.toContain('private-secret');
    }
  );
});
