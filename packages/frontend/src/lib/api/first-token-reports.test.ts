import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportFirstTokenRequest } from '@miniapp/shared';

const mock = vi.hoisted(() => ({ owner: 111, api: vi.fn() }));
vi.mock('./client', () => ({ apiClient: mock.api }));
vi.mock('@/lib/telegram/auth', () => ({ getRawInitData: () => undefined }));
vi.mock('@/lib/telegram/user', () => ({ parseTelegramUser: () => ({ id: mock.owner }) }));
import {
  __resetFirstTokenReportsForTests,
  reportConversationFirstToken,
  recoverPendingFirstTokenReports,
} from './first-token-reports';

const session = '11111111-1111-4111-8111-111111111111';
const storage = new Map<string, string>();
const stored = () =>
  JSON.parse(storage.get('miniapp:first-token-receipts:v1:111') ?? '[]') as {
    attempts: number;
    body: ReportFirstTokenRequest;
  }[];
function receipt(index = 1): ReportFirstTokenRequest {
  return {
    request_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    assistant_message_id: '22222222-2222-4222-8222-222222222222',
    revision: 0,
    measurement_method: 'client_committed_v4',
    outcome: 'observed',
    first_token_visible_ms: 2100,
    wait_finished_ms: 2100,
    request_dispatched_ms: 20,
    first_token_received_ms: 2000,
    backgrounded: false,
    reason: null,
  };
}
async function enqueue(body = receipt()) {
  const run = reportConversationFirstToken(session, body);
  await vi.runAllTimersAsync();
  await run;
}
beforeEach(() => {
  vi.useFakeTimers();
  __resetFirstTokenReportsForTests();
  storage.clear();
  mock.owner = 111;
  mock.api.mockReset();
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal('AbortSignal', { timeout: undefined });
});
afterEach(() => {
  __resetFirstTokenReportsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bounded per-user receipt recovery', () => {
  it('confirms once, removes the local copy, and ignores repeated terminal callbacks', async () => {
    mock.api.mockResolvedValue({ recorded: true });
    await enqueue();
    await enqueue();
    expect(mock.api).toHaveBeenCalledOnce();
    expect(storage.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the first payload immutable while a confirmation is in flight', async () => {
    let accept!: (v: { recorded: boolean }) => void;
    mock.api.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        })
    );
    const body = receipt();
    const run = reportConversationFirstToken(session, body);
    body.first_token_visible_ms = 5900;
    await reportConversationFirstToken(session, {
      ...body,
      outcome: 'timed_out',
      first_token_visible_ms: null,
      reason: 'not_visible',
    });
    expect(JSON.parse(mock.api.mock.calls[0]![1].body).first_token_visible_ms).toBe(2100);
    accept({ recorded: true });
    await run;
    expect(mock.api).toHaveBeenCalledOnce();
  });
  it('persists an offline result and recovers it after a process reload without polling', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await enqueue();
    expect(mock.api).not.toHaveBeenCalled();
    expect(stored()[0]!.attempts).toBe(0);
    __resetFirstTokenReportsForTests();
    vi.stubGlobal('navigator', { onLine: true });
    mock.api.mockResolvedValue({ recorded: true });
    await recoverPendingFirstTokenReports();
    expect(mock.api).toHaveBeenCalledOnce();
    expect(mock.api.mock.calls[0]![1].queuePriority).toBe('background');
    expect(storage.size).toBe(0);
  });
  it('preserves the three consumed attempts across reload and permits only one final recovery', async () => {
    mock.api.mockRejectedValue(new TypeError('offline'));
    await enqueue();
    expect(mock.api).toHaveBeenCalledTimes(3);
    expect(stored()[0]!.attempts).toBe(3);
    __resetFirstTokenReportsForTests();
    await recoverPendingFirstTokenReports();
    expect(mock.api).toHaveBeenCalledTimes(4);
    expect(storage.size).toBe(0);
    await vi.advanceTimersByTimeAsync(30000);
    await recoverPendingFirstTokenReports();
    expect(mock.api).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not send a different user's pending receipts", async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await enqueue();
    mock.owner = 222;
    vi.stubGlobal('navigator', { onLine: true });
    mock.api.mockResolvedValue({ recorded: true });
    await recoverPendingFirstTokenReports();
    expect(mock.api).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(1);
    mock.owner = 111;
    await vi.advanceTimersByTimeAsync(30000);
    await recoverPendingFirstTokenReports();
    expect(mock.api).toHaveBeenCalledOnce();
  });
  it('caps local results at twenty and discards expired results without server reads', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    for (let i = 1; i <= 25; i++) await enqueue(receipt(i));
    expect(stored()).toHaveLength(20);
    expect(mock.api).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(86400001);
    vi.stubGlobal('navigator', { onLine: true });
    await recoverPendingFirstTokenReports();
    expect(mock.api).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });
  it('sends at most four serial recoveries per wake and coalesces event storms', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    for (let i = 1; i <= 6; i++) await enqueue(receipt(i));
    vi.stubGlobal('navigator', { onLine: true });
    mock.api.mockResolvedValue({ recorded: true });
    await Promise.all([
      recoverPendingFirstTokenReports(),
      recoverPendingFirstTokenReports(),
      recoverPendingFirstTokenReports(),
    ]);
    expect(mock.api).toHaveBeenCalledTimes(4);
    expect(stored()).toHaveLength(2);
    await recoverPendingFirstTokenReports();
    expect(mock.api).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(30000);
    await recoverPendingFirstTokenReports();
    expect(mock.api).toHaveBeenCalledTimes(6);
  });
  it('reports safely when local storage is denied', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw Error('denied');
      },
      setItem: () => {
        throw Error('denied');
      },
      removeItem: () => {
        throw Error('denied');
      },
    });
    mock.api.mockResolvedValue({ recorded: true });
    await expect(enqueue()).resolves.toBeUndefined();
    expect(mock.api).toHaveBeenCalledOnce();
  });
  it('recovers an early-departure result using only the original request ID', async () => {
    const body = {
      ...receipt(),
      assistant_message_id: null,
      revision: null,
      outcome: 'not_observed' as const,
      first_token_visible_ms: null,
      first_token_received_ms: null,
      reason: 'page_left' as const,
      backgrounded: true,
      wait_finished_ms: 770,
    };
    vi.stubGlobal('navigator', { onLine: false });
    await enqueue(body);
    __resetFirstTokenReportsForTests();
    vi.stubGlobal('navigator', { onLine: true });
    mock.api.mockResolvedValue({ recorded: true });
    await recoverPendingFirstTokenReports();
    expect(JSON.parse(mock.api.mock.calls[0]![1].body)).toEqual(body);
    expect(storage.size).toBe(0);
  });
});
