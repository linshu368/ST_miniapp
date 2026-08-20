import { createHash, createSign, createVerify, generateKeyPairSync } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function createLegacyGateway() {
  return new JLPaymentGateway({
    merchantId: '1002',
    merchantKey: 'legacy-secret',
    baseUrl: 'https://legacy.example',
    notifyUrl: 'https://backend.example/notify',
    returnUrl: 'https://backend.example/return',
  });
}

function signLegacyMd5(params: Record<string, string>, merchantKey: string): string {
  const signSource =
    Object.keys(params)
      .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key])
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&') + merchantKey;
  return createHash('md5').update(signSource).digest('hex');
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

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
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

  it.each([
    {
      payType: 'qrcode',
      payInfo: 'weixin://wxpay/bizpayurl?pr=test',
    },
    {
      payType: 'jump',
      payInfo: 'https://pay.example/checkout',
    },
  ])('rejects $payType responses instead of opening a QR cashier', async ({ payType, payInfo }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response: Record<string, unknown> = {
          code: 0,
          trade_no: 'provider-order',
          pay_type: payType,
          pay_info: payInfo,
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
      errorMessage: `支付厂商未返回微信直达 scheme（${payType}）`,
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

describe('JLPaymentGateway legacy', () => {
  const alipayParams = {
    type: 'alipay' as const,
    outTradeNo: 'merchant-order',
    amount: '1.00',
    userId: 'user-id',
    productName: '星尘充值',
    clientIp: '203.0.113.8',
  };

  it('posts type=alipay to mapi.php with an independently verifiable MD5 sign', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://legacy.example/mapi.php');
      const request = Object.fromEntries(new URLSearchParams(String(init?.body)));
      expect(request).toMatchObject({
        pid: '1002',
        type: 'alipay',
        out_trade_no: 'merchant-order',
        money: '1.00',
        sign_type: 'MD5',
      });
      expect(request.sign).toEqual(expect.any(String));
      expect(request.sign).toBe(signLegacyMd5(request, 'legacy-secret'));

      return new Response(JSON.stringify({ code: 0, msg: 'ignored' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await createLegacyGateway().createPayment(alipayParams);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns the cashier payurl when the vendor responds with code=1', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            code: 1,
            payurl: 'https://pay.example/cashier?order=merchant-order',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      })
    );

    await expect(createLegacyGateway().createPayment(alipayParams)).resolves.toEqual({
      success: true,
      paymentUrl: 'https://pay.example/cashier?order=merchant-order',
    });
  });
});
