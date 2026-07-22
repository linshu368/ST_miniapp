import { createSign, createVerify, generateKeyPairSync } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JLPaymentGateway } from './JLPaymentGateway.js';

const merchantKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

function createGateway() {
  return new JLPaymentGateway({
    merchantId: '1002',
    merchantKey: 'legacy-secret',
    baseUrl: 'https://legacy.example',
    v2BaseUrl: 'https://v2.example',
    merchantPrivateKey: merchantKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    platformPublicKey: platformKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    notifyUrl: 'https://backend.example/notify',
    returnUrl: 'https://backend.example/return',
  });
}

function signingSource(params: Record<string, unknown>): string {
  return Object.keys(params)
    .filter(
      (key) =>
        key !== 'sign' &&
        key !== 'sign_type' &&
        params[key] !== undefined &&
        params[key] !== null &&
        params[key] !== ''
    )
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join('&');
}

function signPlatform(params: Record<string, unknown>): string {
  const signer = createSign('RSA-SHA256');
  signer.update(signingSource(params));
  signer.end();
  return signer.sign(platformKeys.privateKey, 'base64');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('JLPaymentGateway V2', () => {
  it('requests mobile web payment and returns the direct WeChat scheme', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const request = Object.fromEntries(new URLSearchParams(String(init?.body)));
        expect(request).toMatchObject({
          method: 'web',
          device: 'mobile',
          type: 'wxpay',
          clientip: '203.0.113.8',
          sign_type: 'RSA',
        });

        const verifier = createVerify('RSA-SHA256');
        verifier.update(signingSource(request));
        verifier.end();
        expect(request.sign).toEqual(expect.any(String));
        expect(verifier.verify(merchantKeys.publicKey, request.sign!, 'base64')).toBe(true);

        const response: Record<string, unknown> = {
          code: 0,
          trade_no: 'provider-order',
          pay_type: 'scheme',
          pay_info: 'weixin://dl/business/?ticket=test',
          timestamp: '1784730000',
          sign_type: 'RSA',
        };
        response.sign = signPlatform(response);
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );

    await expect(
      createGateway().createPayment({
        type: 'wxpay',
        outTradeNo: 'merchant-order',
        amount: '1.00',
        userId: 'user-id',
        productName: '星尘充值',
        clientIp: '203.0.113.8',
      })
    ).resolves.toEqual({
      success: true,
      paymentUrl: 'weixin://dl/business/?ticket=test',
    });
  });

  it('rejects QR-code-only responses instead of sending users to a QR page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response: Record<string, unknown> = {
          code: 0,
          trade_no: 'provider-order',
          pay_type: 'qrcode',
          pay_info: 'weixin://wxpay/bizpayurl?pr=test',
          timestamp: '1784730000',
          sign_type: 'RSA',
        };
        response.sign = signPlatform(response);
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );

    const result = await createGateway().createPayment({
      type: 'wxpay',
      outTradeNo: 'merchant-order',
      amount: '1.00',
      userId: 'user-id',
      productName: '星尘充值',
      clientIp: '203.0.113.8',
    });

    expect(result).toEqual({
      success: false,
      errorMessage: '支付通道未返回微信直达链接（qrcode）',
    });
  });

  it('verifies RSA-signed V2 notifications', () => {
    const notify: Record<string, string> = {
      pid: '1002',
      out_trade_no: 'merchant-order',
      trade_no: 'provider-order',
      type: 'wxpay',
      trade_status: 'TRADE_SUCCESS',
      money: '1.00',
      timestamp: '1784730000',
      sign_type: 'RSA',
    };
    notify.sign = signPlatform(notify);

    expect(createGateway().verifyNotifySign(notify)).toBe(true);
  });
});
