import { describe, expect, it } from 'vitest';

import { sanitizeTelemetry } from './sanitize';

describe('sanitizeTelemetry', () => {
  it('redacts sensitive keys case-insensitively at every depth', () => {
    const input = {
      Authorization: 'Bearer secret',
      nested: {
        'X-Init-Data': 'signed telegram data',
        access_token: 'access secret',
        characterId: 'character-1',
      },
    };

    expect(sanitizeTelemetry(input)).toEqual({
      Authorization: '[Filtered]',
      nested: {
        'X-Init-Data': '[Filtered]',
        access_token: '[Filtered]',
        characterId: 'character-1',
      },
    });
  });

  it('redacts authentication query parameters while preserving ordinary text', () => {
    const input = {
      url: 'https://example.test/path?foo=hello&tgWebAppData=signed-data&token=abc#section',
      conversation: '用户说：请保留这段正常对话。',
    };

    expect(sanitizeTelemetry(input)).toEqual({
      url: 'https://example.test/path?foo=hello&tgWebAppData=[Filtered]&token=[Filtered]#section',
      conversation: '用户说：请保留这段正常对话。',
    });
  });

  it('redacts Telegram init data at the start of a URL fragment', () => {
    const input = {
      url: 'https://example.test/#tgWebAppData=user%3D1%26auth_date%3D2%26hash%3Dsigned&tgWebAppVersion=8.0',
    };

    expect(sanitizeTelemetry(input)).toEqual({
      url: 'https://example.test/#tgWebAppData=[Filtered]&tgWebAppVersion=8.0',
    });
  });

  it('sanitizes arrays without mutating the original value', () => {
    const input = {
      headers: [{ Cookie: 'session=secret' }, { accept: 'application/json' }],
    };
    const output = sanitizeTelemetry(input);

    expect(output).toEqual({
      headers: [{ Cookie: '[Filtered]' }, { accept: 'application/json' }],
    });
    expect(input).toEqual({
      headers: [{ Cookie: 'session=secret' }, { accept: 'application/json' }],
    });
    expect(output).not.toBe(input);
    expect(output.headers).not.toBe(input.headers);
  });
});
