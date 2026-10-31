import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramGroupMessageInput } from '@miniapp/shared';
import { forwardGroupMessageToCs } from './cs-service.js';

vi.mock('../platform/config.js', () => ({
  config: {
    csService: { url: 'https://cs.example.test', secret: 'cs-unit-test-secret' },
  },
}));

const PRIVATE_TEXT = 'PRIVATE_GROUP_TEXT_SHOULD_NOT_LEAK';
const input: TelegramGroupMessageInput = {
  bot_source: 'main',
  chat_id: '-1001234567890',
  chat_title: 'Test group',
  message_id: '77',
  telegram_user_id: '123456',
  sender_name: 'Test sender',
  is_bot: false,
  text: PRIVATE_TEXT,
  sent_at: '2026-10-22T10:00:00.000Z',
  reply_to_message_id: '70',
  photo_file_id: 'test-photo-file-id',
  edited: true,
  edited_at: '2026-10-22T10:01:00.000Z',
  sender_chat_id: null,
  message_thread_id: '10',
};

describe('forwardGroupMessageToCs', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('posts the exact group contract with authentication and a 5-second persistence deadline', async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    fetchMock.mockResolvedValue(Response.json({ success: true, data: { stored: true } }));

    await expect(forwardGroupMessageToCs(input)).resolves.toBeUndefined();

    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://cs.example.test/internal/telegram/group-message',
      {
        method: 'POST',
        headers: {
          'x-cs-internal-secret': 'cs-unit-test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
        signal,
      }
    );
  });

  it('accepts a 201 persistence receipt with success:true', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true }, { status: 201 }));
    await expect(forwardGroupMessageToCs(input)).resolves.toBeUndefined();
  });

  it.each([
    { name: 'HTTP 400', status: 400, payload: { success: false, error: PRIVATE_TEXT } },
    { name: 'HTTP 503', status: 503, payload: { success: true, data: PRIVATE_TEXT } },
    {
      name: 'HTTP 200 error envelope',
      status: 200,
      payload: { success: false, error: PRIVATE_TEXT },
    },
    { name: 'missing success', status: 200, payload: { data: PRIVATE_TEXT } },
    { name: 'non-boolean success', status: 200, payload: { success: 'true', data: PRIVATE_TEXT } },
    { name: 'primitive JSON', status: 200, payload: PRIVATE_TEXT },
  ])('rejects $name without exposing response content', async ({ status, payload }) => {
    fetchMock.mockResolvedValue(Response.json(payload, { status }));

    const error: unknown = await forwardGroupMessageToCs(input).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected group persistence failure');
    expect(error.message).toBe(`cs service did not persist group message: HTTP ${status}`);
    expect(error.message).not.toContain(PRIVATE_TEXT);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a non-JSON response without exposing its body', async () => {
    fetchMock.mockResolvedValue(new Response(PRIVATE_TEXT, { status: 502 }));

    const error: unknown = await forwardGroupMessageToCs(input).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected non-JSON persistence failure');
    expect(error.message).toBe('cs service returned non-JSON response: HTTP 502');
    expect(error.message).not.toContain(PRIVATE_TEXT);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
