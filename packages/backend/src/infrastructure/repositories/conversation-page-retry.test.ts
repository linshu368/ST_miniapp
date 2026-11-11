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
});
