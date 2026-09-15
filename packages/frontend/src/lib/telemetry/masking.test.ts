import { describe, expect, it } from 'vitest';

import {
  PH_CHAT_REPLAY_VISIBLE_CLASS,
  maskReplayAttribute,
  maskReplayInput,
  redactCapturedNetworkRequest,
  redactReplayUrl,
} from './masking';

describe('replay masking', () => {
  it('keeps chat composer text inside the approved visible region', () => {
    const element = {
      closest: (selector: string) =>
        selector === `.${PH_CHAT_REPLAY_VISIBLE_CLASS}` ? element : null,
    } as unknown as HTMLElement;
    expect(maskReplayInput('hello', element)).toBe('hello');
  });

  it('masks inputs outside the chat region', () => {
    const element = { closest: () => null } as unknown as HTMLElement;
    expect(maskReplayInput('secret', element)).toBe('******');
  });

  it('strips query strings and pay_url from captured URLs', () => {
    expect(
      redactReplayUrl('https://app.example/recharge/1?pay_url=https://pay.example/x&x=1')
    ).toBe('https://app.example/recharge/1');
    expect(maskReplayAttribute('href', 'https://pay.example/checkout?token=abc')).toBe(
      'https://pay.example/checkout'
    );
  });

  it('drops network bodies and headers while keeping a redacted URL', () => {
    const redacted = redactCapturedNetworkRequest({
      name: 'https://api.example/orders?pay_url=secret',
      duration: 0,
      entryType: 'resource',
      startTime: 0,
      requestBody: '{"password":"x"}',
      responseBody: '{"token":"y"}',
      requestHeaders: { authorization: 'Bearer x' },
      responseHeaders: { 'set-cookie': 'a' },
    });
    expect(redacted?.name).toBe('https://api.example/orders');
    expect(redacted?.requestBody).toBeUndefined();
    expect(redacted?.responseBody).toBeUndefined();
    expect(redacted?.requestHeaders).toBeUndefined();
    expect(redacted?.responseHeaders).toBeUndefined();
  });
});
