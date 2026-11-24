import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichErrorDiagnostic } from './error-diagnostics';
import { recordTelegramInitState, rememberRequestFailure } from './diagnostic-state';
import type { ErrorEvent } from '@sentry/nextjs';
const sendSentryLog = vi.hoisted(() => vi.fn());
vi.mock('./client', () => ({ sendSentryLog }));
import { reportReplyFallback } from './reply-diagnostics';
afterEach(() => vi.unstubAllGlobals());

function browser() {
  vi.stubGlobal('window', {
    location: { pathname: '/characters' },
    innerWidth: 390,
    innerHeight: 844,
    scrollY: 100,
    __miniappStartup: { status: 'sent' },
  });
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    documentElement: { scrollHeight: 2000, scrollWidth: 390 },
    querySelector: () => null,
  });
}
describe('original Sentry failure evidence', () => {
  it('bounds fallback logs, rejects arbitrary reason text and isolates a failed exporter', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    reportReplyFallback('private reply body');
    expect(sendSentryLog).not.toHaveBeenCalled();
    reportReplyFallback('WORKER_ERROR');
    reportReplyFallback('WORKER_ERROR');
    expect(sendSentryLog).toHaveBeenCalledOnce();
    sendSentryLog.mockImplementation(() => {
      throw new Error('export unavailable');
    });
    for (let n = 1; n < 12; n++) {
      now.mockReturnValue(n * 60001);
      expect(() => reportReplyFallback('WORKER_ERROR')).not.toThrow();
    }
    expect(sendSentryLog).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(sendSentryLog.mock.calls)).not.toContain('private');
    now.mockRestore();
  });
  it('keeps the original exception and grouping while adding only bounded bridge state', () => {
    browser();
    recordTelegramInitState('failed');
    const event: ErrorEvent = {
      type: undefined,
      message: 'TelegramGameProxy.receiveEvent unavailable',
      fingerprint: ['original'],
    };
    const result = enrichErrorDiagnostic(event);
    expect(result.fingerprint).toEqual(['original']);
    expect(result.contexts?.st_failure_diagnostic).toMatchObject({
      category: 'telegram_bridge',
      sdk_state: 'failed',
      receiver_present: false,
      html_ready: true,
    });
    expect(JSON.stringify(result.contexts)).not.toContain('initData');
  });
  it('reports layout state without inventing an observer source or business failure', () => {
    browser();
    expect(
      enrichErrorDiagnostic({ type: undefined, message: 'ResizeObserver loop limit exceeded' })
        .contexts?.st_failure_diagnostic
    ).toMatchObject({
      category: 'resize_observer',
      observer_source: 'unattributed',
      viewport_width: 390,
      dialog_open: false,
    });
  });
  it('only associates a request when the original error object was observed', () => {
    browser();
    const error = new DOMException('private detail', 'AbortError');
    rememberRequestFailure(error, {
      api_route: 'creator',
      phase: 'body',
      caller_cancelled: true,
      external_aborted: true,
      deadline: false,
    });
    const event: ErrorEvent = {
      type: undefined,
      exception: { values: [{ type: 'AbortError', value: 'private detail' }] },
    };
    expect(
      enrichErrorDiagnostic(event, { originalException: error }).contexts?.st_failure_diagnostic
    ).toMatchObject({
      correlation: 'same_error_object',
      api_route: 'creator',
      phase: 'body',
      caller_cancelled: true,
    });
    expect(enrichErrorDiagnostic(event).contexts?.st_failure_diagnostic).toMatchObject({
      correlation: 'unattributed',
    });
  });
  it('leaves unrelated events and broken DOM environments intact', () => {
    const event: ErrorEvent = { type: undefined, message: 'other failure' };
    expect(enrichErrorDiagnostic(event)).toBe(event);
    vi.stubGlobal('window', {});
    expect(
      enrichErrorDiagnostic({ type: undefined, message: 'ResizeObserver loop limit exceeded' })
        .contexts
    ).toBeUndefined();
  });
});
