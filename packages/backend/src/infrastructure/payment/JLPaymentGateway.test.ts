import { createSign, createVerify, generateKeyPairSync } from 'crypto';
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

// 生产未配置 V2，走的是 mapi.php 老链路
function createLegacyGateway(options?: { alipaySchemeEnabled?: boolean }) {
  return new JLPaymentGateway({
    merchantId: '1002',
    merchantKey: 'legacy-secret',
    baseUrl: 'https://legacy.example',
    notifyUrl: 'https://backend.example/notify',
    returnUrl: 'https://backend.example/return',
    ...options,
  });
}

const BRIDGE_URL = 'https://legacy.example/pay/submit/2026/';
const QR_CONTENT = 'http://198.51.100.7:8080/pay/PayInfo.php?orderno=BO1';

function bridgeHtml(action: string): string {
  return `<html><body><form id="dopay" action="${action}" method="post">
    <input type="hidden" name="pid" value="106963028188160"/>
    <input type="hidden" name="type" value="alipay"/>
    <input type="hidden" name="name" value="\u661f\u5c18\u5145\u503c"/>
    <input type="submit" value="\u6b63\u5728\u8df3\u8f6c">
    </form><script>document.getElementById("dopay").submit();</script></body></html>`;
}

/** 按厂商真实链路顺序返回：下单 → 中转页 → 上游 302 → 收银台轮询 */
function stubVendorChain(options: {
  cashierUrl: string;
  polling?: Record<string, unknown>;
  onUpstream?: () => Response;
}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);

      if (url.endsWith('/mapi.php')) {
        return new Response(JSON.stringify({ code: 1, payurl: BRIDGE_URL }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === BRIDGE_URL) {
        return new Response(bridgeHtml('https://upstream.example/api/epay/submit.php'));
      }
      if (url.includes('upstream.example')) {
        return options.onUpstream?.() ?? Response.redirect(options.cashierUrl, 302);
      }
      if (url.includes('/cas/order/polling')) {
        return new Response(JSON.stringify(options.polling ?? {}), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    })
  );
  return calls;
}

function createAlipayOrder(gateway = createLegacyGateway()) {
  return gateway.createPayment({
    type: 'alipay',
    outTradeNo: 'merchant-order',
    amount: '1.00',
    userId: 'user-id',
    productName: '星尘充值',
    clientIp: '203.0.113.8',
  });
}

describe('JLPaymentGateway 支付宝直达 scheme', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('把收银台返回的中转页套成支付宝 H5 容器唤起协议', async () => {
    const calls = stubVendorChain({
      cashierUrl: 'https://cashier.example/a1341599655513165824.html',
      polling: { status: 'TRADE_PENDING', qrcode: QR_CONTENT, urlScheme: '' },
    });

    await expect(createAlipayOrder()).resolves.toEqual({
      success: true,
      paymentUrl: BRIDGE_URL,
      paymentScheme: `alipays://platformapi/startapp?appId=20000067&url=${encodeURIComponent(QR_CONTENT)}`,
    });
    expect(calls).toHaveLength(4);
    expect(calls[3]).toBe('https://cashier.example/cas/order/polling?orderId=1341599655513165824');
  });

  it('厂商已经给出 alipays:// 时直接透传', async () => {
    stubVendorChain({
      cashierUrl: 'https://cashier.example/a1341599655513165824.html',
      polling: { qrcode: QR_CONTENT, urlScheme: 'alipays://platformapi/startapp?appId=20000067' },
    });

    await expect(createAlipayOrder()).resolves.toMatchObject({
      paymentScheme: 'alipays://platformapi/startapp?appId=20000067',
    });
  });

  it.each([
    {
      name: '收银台是微信模式',
      chain: { cashierUrl: 'https://cashier.example/w1341599655513165824.html' },
    },
    {
      name: '轮询没返回二维码',
      chain: {
        cashierUrl: 'https://cashier.example/a1341599655513165824.html',
        polling: { status: 'TRADE_PENDING' },
      },
    },
    {
      name: '上游没有 302',
      chain: {
        cashierUrl: 'https://cashier.example/a1341599655513165824.html',
        onUpstream: () => new Response('{"code":500}', { status: 200 }),
      },
    },
  ])('$name 时回退到原始跳转页', async ({ chain }) => {
    stubVendorChain(chain);

    const result = await createAlipayOrder();
    expect(result.success).toBe(true);
    expect(result.paymentUrl).toBe(BRIDGE_URL);
    expect(result.paymentScheme).toBeUndefined();
  });

  it('开关关闭时不去访问厂商收银台', async () => {
    const calls = stubVendorChain({
      cashierUrl: 'https://cashier.example/a1341599655513165824.html',
      polling: { qrcode: QR_CONTENT },
    });

    const result = await createAlipayOrder(createLegacyGateway({ alipaySchemeEnabled: false }));
    expect(result.paymentScheme).toBeUndefined();
    expect(calls).toEqual(['https://legacy.example/mapi.php']);
  });

  it('微信下单不触发 scheme 解析', async () => {
    const calls = stubVendorChain({
      cashierUrl: 'https://cashier.example/w1341599655513165824.html',
    });

    await createLegacyGateway().createPayment({
      type: 'wxpay',
      outTradeNo: 'merchant-order',
      amount: '1.00',
      userId: 'user-id',
      productName: '星尘充值',
      clientIp: '203.0.113.8',
    });
    expect(calls).toEqual(['https://legacy.example/mapi.php']);
  });
});
