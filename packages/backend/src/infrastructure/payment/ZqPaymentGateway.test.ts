import { createSign, createVerify, generateKeyPairSync } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ZqPaymentGateway, type ZqPaymentNotifyData } from './ZqPaymentGateway.js';

const merchantKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

function createGateway() {
  return new ZqPaymentGateway({
    baseUrl: 'https://zq.example/',
    merchantId: '55',
    merchantPrivateKey: merchantKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    platformPublicKey: platformKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    notifyUrl: 'https://backend.example/api/payment/webhook/zqpay',
    returnUrl: 'https://backend.example/api/payment/return',
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

function mockCreateResponse(overrides: Record<string, unknown> = {}) {
  const { sign: signOverride, ...responseOverrides } = overrides;
  const result: Record<string, unknown> = {
    code: 0,
    trade_no: 'ZQ-ORDER-1',
    pay_type: 'jump',
    pay_info: 'https://zq.example/pay/ZQ-ORDER-1',
    timestamp: '1787302800',
    sign_type: 'RSA',
    extension_field: 'supported',
    ...responseOverrides,
  };
  result.sign = typeof signOverride === 'string' ? signOverride : signPlatform(result);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(result), { status: 200 }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ZqPaymentGateway', () => {
  it('signs a V2 jump payment request and verifies the response', async () => {
    mockCreateResponse();

    const result = await createGateway().createPayment({
      type: 'wxpay',
      outTradeNo: 'MA-order-1',
      amount: '6.00',
      userId: 'user-1',
      productName: '星尘充值 600',
      clientIp: '127.0.0.1',
    });

    expect(result).toEqual({
      success: true,
      paymentUrl: 'https://zq.example/pay/ZQ-ORDER-1',
    });

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://zq.example/api/pay/create');
    expect(init?.method).toBe('POST');

    const request = Object.fromEntries(new URLSearchParams(String(init?.body)).entries()) as Record<
      string,
      string
    >;
    expect(request).toMatchObject({
      pid: '55',
      method: 'jump',
      type: 'wxpay',
      out_trade_no: 'MA-order-1',
      money: '6.00',
      sign_type: 'RSA',
    });

    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingSource(request));
    verifier.end();
    expect(verifier.verify(merchantKeys.publicKey, request.sign ?? '', 'base64')).toBe(true);
  });

  it('fails closed when the platform response signature is invalid', async () => {
    mockCreateResponse({ sign: 'invalid' });

    await expect(
      createGateway().createPayment({
        type: 'alipay',
        outTradeNo: 'MA-order-2',
        amount: '28.00',
        userId: 'user-2',
        productName: '星尘充值 3000',
        clientIp: '127.0.0.1',
      })
    ).resolves.toEqual({
      success: false,
      errorMessage: '支付平台响应验签失败',
    });
  });

  it('rejects non-jump responses and unsafe payment URLs', async () => {
    mockCreateResponse({ pay_type: 'qrcode' });
    await expect(
      createGateway().createPayment({
        type: 'wxpay',
        outTradeNo: 'MA-order-3',
        amount: '6.00',
        userId: 'user-3',
        productName: '星尘充值 600',
        clientIp: '127.0.0.1',
      })
    ).resolves.toMatchObject({ success: false });

    vi.unstubAllGlobals();
    mockCreateResponse({ pay_info: 'javascript:alert(1)' });
    await expect(
      createGateway().createPayment({
        type: 'wxpay',
        outTradeNo: 'MA-order-4',
        amount: '6.00',
        userId: 'user-4',
        productName: '星尘充值 600',
        clientIp: '127.0.0.1',
      })
    ).resolves.toEqual({
      success: false,
      errorMessage: '支付平台返回了无效跳转地址',
    });
  });

  it('verifies callback signatures including unknown extension fields', () => {
    const notify: ZqPaymentNotifyData = {
      pid: '55',
      trade_no: 'ZQ-ORDER-1',
      out_trade_no: 'MA-order-1',
      trade_status: 'TRADE_SUCCESS',
      money: '6.00',
      timestamp: Math.floor(Date.now() / 1000).toString(),
      sign_type: 'RSA',
      future_field: 'future-value',
    };
    notify.sign = signPlatform(notify);

    const gateway = createGateway();
    expect(gateway.isExpectedMerchant(notify.pid)).toBe(true);
    expect(gateway.verifyNotifySign(notify)).toBe(true);

    notify.future_field = 'tampered';
    expect(gateway.verifyNotifySign(notify)).toBe(false);
  });
});
