import { describe, expect, it } from 'vitest';
import { EpayNotificationSchema, EpayQueryResponseSchema } from '../api/payment.js';
import { sanitizeTelemetry } from '../telemetry/sanitize.js';

describe('epay contracts and telemetry', () => {
  const notification = {
    pid: '1001',
    trade_no: '202611091234',
    out_trade_no: 'EP' + 'a'.repeat(30),
    type: 'wxpay',
    name: 'fixture',
    money: '6.000',
    trade_status: 'TRADE_SUCCESS',
    param: 'fixture-env',
    sign: 'a'.repeat(32),
    sign_type: 'MD5',
  };

  it('keeps signed extension fields and enforces the separate provider namespace', () => {
    expect(EpayNotificationSchema.parse({ ...notification, extension: '0' }).extension).toBe('0');
    expect(
      EpayNotificationSchema.safeParse({ ...notification, out_trade_no: 'MA_legacy' }).success
    ).toBe(false);
    expect(
      EpayNotificationSchema.safeParse({ ...notification, trade_status: 'SUCCESS' }).success
    ).toBe(false);
    expect(EpayNotificationSchema.safeParse({ ...notification, param: '' }).success).toBe(false);
  });
  it('accepts only explicit paid/unpaid query statuses and string amounts', () => {
    const result = { ...notification, pid: 1001, code: 1, status: 1 };
    expect(EpayQueryResponseSchema.safeParse(result).success).toBe(true);
    expect(EpayQueryResponseSchema.safeParse({ ...result, status: '1' }).success).toBe(false);
    expect(EpayQueryResponseSchema.safeParse({ ...result, money: 6 }).success).toBe(false);
  });
  it('scrubs credentials and payment callbacks from errors, breadcrumbs and span attributes', () => {
    const result = sanitizeTelemetry({
      request: {
        url: 'https://provider.example/api/epay/api.php?act=order&key=fixture-secret&pid=1001',
      },
      spans: [
        {
          description: 'GET https://provider.example/api/epay/api.php?key=fixture-secret&act=order',
          data: {
            'url.full':
              'https://backend.example/api/payment/notify/ttzf?sign=fixture-sign&name=private-name',
          },
        },
      ],
      breadcrumb: { url: '/api/payment/return?buyer=private-buyer&sign=fixture-sign' },
      data: {
        appKey: 'fixture-secret',
        sign: 'fixture-sign',
        clientip: '203.0.113.10',
        buyer: 'private-buyer',
      },
      body: 'key=fixture-secret&sign=fixture-sign&clientip=203.0.113.10',
    });
    const text = JSON.stringify(result);
    for (const secret of [
      'fixture-secret',
      'fixture-sign',
      'private-name',
      'private-buyer',
      '203.0.113.10',
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain('[Filtered]');
  });
});
