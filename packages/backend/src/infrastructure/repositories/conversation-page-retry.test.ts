import { describe, expect, it, vi } from 'vitest';
import { readConversationPage } from './conversation-page-retry.js';

describe('history read recovery', () => {
  it('recovers one recognized transport interruption without repeating writes', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'TypeError: fetch failed', details: 'ECONNRESET' },
      })
      .mockResolvedValueOnce({ data: ['complete page'], error: null });
    expect(await readConversationPage(read)).toMatchObject({
      data: ['complete page'],
      attempts: 2,
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it.each([
    { message: 'canceling statement due to statement timeout', code: '57014' },
    { message: 'AbortError: operation aborted' },
    { message: 'Internal Server Error' },
    { message: 'permission denied', code: '42501' },
  ])('does not retry $message', async (error) => {
    const read = vi.fn().mockResolvedValue({ data: null, error });
    await expect(readConversationPage(read)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('caps repeated connection failure at two attempts', async () => {
    const read = vi.fn().mockResolvedValue({ data: null, error: { message: 'UND_ERR_SOCKET' } });
    await expect(readConversationPage(read)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('stops before a disconnected client starts a database request', async () => {
    const read = vi.fn();
    await expect(readConversationPage(read, AbortSignal.abort())).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects missing data instead of manufacturing an empty history', async () => {
    await expect(readConversationPage(async () => ({ data: null, error: null }))).rejects.toThrow();
  });
  it('preserves a database error racing a disconnect', async () => {
    const controller = new AbortController();
    const failure = { code: '42501', message: 'fixture permission failure' };
    await expect(
      readConversationPage(async () => {
        controller.abort(new DOMException('fixture_close', 'AbortError'));
        return { data: null, error: failure };
      }, controller.signal)
    ).rejects.toMatchObject({ cause: failure });
  });
  it('recognizes only the serialized caller reason', async () => {
    const controller = new AbortController();
    const reason = new DOMException('fixture_close', 'AbortError');
    await expect(
      readConversationPage(async () => {
        controller.abort(reason);
        return { data: null, error: { message: 'AbortError: fixture_close' } };
      }, controller.signal)
    ).rejects.toBe(reason);
  });
  it('retains the caller reason when cancelled during retry backoff', async () => {
    const controller = new AbortController();
    const reason = new DOMException('fixture_close', 'AbortError');
    const read = vi.fn().mockResolvedValue({ data: null, error: { message: 'ECONNRESET' } });
    const reading = readConversationPage(read, controller.signal);
    const rejected = expect(reading).rejects.toBe(reason);
    await Promise.resolve();
    controller.abort(reason);
    await rejected;
    expect(read).toHaveBeenCalledOnce();
  });
});
