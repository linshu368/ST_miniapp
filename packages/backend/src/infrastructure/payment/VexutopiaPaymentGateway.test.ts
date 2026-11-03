import { createHmac } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VexutopiaPaymentGateway } from './VexutopiaPaymentGateway.js';

const SECRET = 'whsec_test_secret';

function createGateway(overrides: { apiKey?: string; webhookSecret?: string } = {}) {
  return new VexutopiaPaymentGateway({
    baseUrl: 'https://vex.example/api/v1/',
    apiKey: overrides.apiKey ?? 'vex_test_key',
    webhookSecret: overrides.webhookSecret ?? SECRET,
    returnUrl: 'https://backend.example/api/payment/return',
    environmentTag: 'test-env',
    sleep: async () => undefined,
  });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function stubFetch(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestOf(fetchMock: ReturnType<typeof stubFetch>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

const createParams = {
  orderId: 'MA_user_1700000000000_0001',
  amount: '6.00',
  type: 'alipay' as const,
  description: '星尘',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createPayment', () => {
  it('sends a CNY China Pay request with metadata and a per-order idempotency key', async () => {
    const fetchMock = stubFetch(
      jsonResponse(201, {
        id: 'tx_abc123',
        status: 'pending',
        checkout_url: 'https://checkout.vex.example/pay?session=tx_abc123',
      })
    );

    const result = await createGateway().createPayment({ ...createParams, type: 'wxpay' });

    expect(result).toEqual({
      success: true,
      paymentUrl: 'https://checkout.vex.example/pay?session=tx_abc123',
      providerTransactionId: 'tx_abc123',
    });
    const { url, init, headers } = requestOf(fetchMock);
    expect(url).toBe('https://vex.example/api/v1/payments');
    expect(init.method).toBe('POST');
    expect(headers['X-API-Key']).toBe('vex_test_key');
    expect(headers['Idempotency-Key']).toBe('order-MA_user_1700000000000_0001');
    expect(headers['User-Agent']).toMatch(/^MIJINGAI-/);
    expect(JSON.parse(init.body as string)).toEqual({
      amount: '6.00',
      currency: 'CNY',
      payment_method: 'WXPAY',
      country: 'CN',
      locale: 'zh-CN',
      return_url: 'https://backend.example/api/payment/return?order_id=MA_user_1700000000000_0001',
      description: '星尘',
      metadata: { mijing_order_id: 'MA_user_1700000000000_0001', mijing_env: 'test-env' },
    });
  });

  it('retries a timeout once with the same idempotency key', async () => {
    const fetchMock = stubFetch(
      new DOMException('timed out', 'TimeoutError'),
      jsonResponse(201, { id: 'tx_abc123', checkout_url: 'https://checkout.vex.example/x' })
    );

    const result = await createGateway().createPayment(createParams);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestOf(fetchMock, 1).headers['Idempotency-Key']).toBe(
      requestOf(fetchMock, 0).headers['Idempotency-Key']
    );
    expect(requestOf(fetchMock, 1).init.body).toBe(requestOf(fetchMock, 0).init.body);
  });

  it('gives up after one retry and reports the last error class', async () => {
    const fetchMock = stubFetch(
      jsonResponse(503, { code: 'PROVIDER_UPSTREAM_UNAVAILABLE' }),
      jsonResponse(503, { code: 'PROVIDER_UPSTREAM_UNAVAILABLE' })
    );
    const result = await createGateway().createPayment(createParams);
    expect(result).toMatchObject({
      success: false,
      errorClass: 'provider_unavailable',
      providerCode: 'PROVIDER_UPSTREAM_UNAVAILABLE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [422, 'CHINA_PAY_AMOUNT_TOO_HIGH', 'provider_rejected'],
    [503, 'PAYMENT_METHOD_MAINTENANCE', 'method_maintenance'],
    [401, 'INVALID_API_KEY', 'configuration'],
    [403, 'ACCOUNT_SUSPENDED', 'configuration'],
    [502, 'PROVIDER_ERROR', 'provider_unavailable'],
  ])('does not retry %s %s and classifies it as %s', async (status, code, errorClass) => {
    const fetchMock = stubFetch(jsonResponse(status, { error: 'provider prose', code }));
    const result = await createGateway().createPayment(createParams);
    expect(result).toMatchObject({ success: false, errorClass, providerCode: code });
    expect(result.errorMessage).not.toContain('provider prose');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After on 429 but caps the wait', async () => {
    const sleep = vi.fn(async () => undefined);
    stubFetch(
      jsonResponse(429, { code: 'RATE_LIMITED' }, { 'Retry-After': '30' }),
      jsonResponse(201, { id: 'tx_abc123', checkout_url: 'https://checkout.vex.example/x' })
    );
    const gateway = new VexutopiaPaymentGateway({
      baseUrl: 'https://vex.example/api/v1',
      apiKey: 'k',
      returnUrl: 'https://backend.example/api/payment/return',
      environmentTag: 'test-env',
      sleep,
    });
    expect((await gateway.createPayment(createParams)).success).toBe(true);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('rejects a non-https checkout url or malformed transaction id', async () => {
    stubFetch(jsonResponse(201, { id: 'tx_abc123', checkout_url: 'http://insecure.example/x' }));
    expect(await createGateway().createPayment(createParams)).toMatchObject({
      success: false,
      errorClass: 'response_invalid',
    });
    stubFetch(
      jsonResponse(201, { id: '../admin', checkout_url: 'https://checkout.vex.example/x' })
    );
    expect(await createGateway().createPayment(createParams)).toMatchObject({
      success: false,
      errorClass: 'response_invalid',
    });
  });

  it('refuses to call the provider without an API key', async () => {
    const fetchMock = stubFetch();
    expect(await createGateway({ apiKey: '' }).createPayment(createParams)).toMatchObject({
      success: false,
      errorClass: 'configuration',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('queryOrder', () => {
  const order = { id: 'MA_order_1', provider_transaction_id: 'tx_abc123' };

  it('treats only completed CNY payments as paid', async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, {
        id: 'tx_abc123',
        status: 'completed',
        amount: '1',
        currency: 'CNY',
        metadata: { mijing_order_id: 'MA_order_1' },
      })
    );
    expect(await createGateway().queryOrder(order)).toEqual({
      success: true,
      paid: true,
      status: 'completed',
      amount: '1',
      tradeNo: 'tx_abc123',
    });
    expect(requestOf(fetchMock).url).toBe('https://vex.example/api/v1/payments/tx_abc123');
  });

  it.each(['pending', 'expired', 'cancelled', 'failed', 'refunded'])(
    'reports %s as unpaid',
    async (status) => {
      stubFetch(jsonResponse(200, { id: 'tx_abc123', status, amount: '1', currency: 'CNY' }));
      expect(await createGateway().queryOrder(order)).toMatchObject({ success: true, paid: false });
    }
  );

  it('refuses a completed payment in the wrong currency or for another order', async () => {
    stubFetch(
      jsonResponse(200, { id: 'tx_abc123', status: 'completed', amount: '1', currency: 'USD' })
    );
    expect(await createGateway().queryOrder(order)).toMatchObject({
      success: false,
      errorClass: 'response_invalid',
    });
    stubFetch(
      jsonResponse(200, {
        id: 'tx_abc123',
        status: 'completed',
        amount: '1',
        currency: 'CNY',
        metadata: { mijing_order_id: 'MA_other' },
      })
    );
    expect(await createGateway().queryOrder(order)).toMatchObject({
      success: false,
      errorClass: 'response_invalid',
    });
  });

  it('does not call the provider for an order without a transaction id', async () => {
    const fetchMock = stubFetch();
    expect(
      await createGateway().queryOrder({ id: 'MA_order_1', provider_transaction_id: null })
    ).toMatchObject({ success: false, errorClass: 'missing_provider_ref' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('lookupPayments', () => {
  it('parses results and ignores ids we did not ask for', async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, {
        results: [
          {
            id: 'tx_a',
            found: true,
            status: 'COMPLETED',
            amount: '6',
            currency: 'CNY',
            metadata: { mijing_order_id: 'MA_a' },
          },
          { id: 'tx_b', found: false },
          { id: 'tx_unrequested', found: true, status: 'completed' },
        ],
      })
    );
    const result = await createGateway().lookupPayments(['tx_a', 'tx_b']);
    expect(result).toEqual({
      success: true,
      items: [
        {
          transactionId: 'tx_a',
          found: true,
          status: 'completed',
          amount: '6',
          currency: 'CNY',
          orderId: 'MA_a',
        },
        {
          transactionId: 'tx_b',
          found: false,
          status: undefined,
          amount: undefined,
          currency: undefined,
          orderId: undefined,
        },
      ],
    });
    expect(JSON.parse(requestOf(fetchMock).init.body as string)).toEqual({
      payment_ids: ['tx_a', 'tx_b'],
    });
  });

  it('rejects more than 100 ids per call', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `tx_${i}`);
    await expect(createGateway().lookupPayments(ids)).rejects.toThrow('最多 100');
  });

  it('reports a failed lookup with its error class', async () => {
    stubFetch(new TypeError('fetch failed'));
    expect(await createGateway().lookupPayments(['tx_a'])).toMatchObject({
      success: false,
      errorClass: 'network',
    });
  });
});

describe('verifyWebhook', () => {
  const now = 1_790_000_000_000;
  const body = Buffer.from(
    JSON.stringify({
      event: 'payment.completed',
      payment_id: 'tx_abc123',
      amount: '6',
      currency: 'CNY',
      metadata: { mijing_order_id: 'MA_order_1', mijing_env: 'test-env' },
    })
  );
  const sign = (payload: Buffer, t: number, secret = SECRET) =>
    createHmac('sha256', secret)
      .update(`${t}.${payload.toString('utf8')}`)
      .digest('hex');
  const header = (t: number, v1: string) => `t=${t},v1=${v1}`;
  const t = Math.floor(now / 1000);

  it('accepts a valid signature and returns the parsed event', () => {
    const result = createGateway().verifyWebhook(body, header(t, sign(body, t)), now);
    expect(result).toMatchObject({
      ok: true,
      event: { event: 'payment.completed', metadata: { mijing_order_id: 'MA_order_1' } },
    });
  });

  it('accepts any matching v1 when several are present', () => {
    const result = createGateway().verifyWebhook(
      body,
      `t=${t},v1=${'0'.repeat(64)},v1=${sign(body, t)}`,
      now
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a tampered body', Buffer.from(body.toString().replace('"6"', '"600"'))],
    ['an empty body', Buffer.alloc(0)],
  ])('rejects %s', (_label, tampered) => {
    expect(createGateway().verifyWebhook(tampered, header(t, sign(body, t)), now)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects a signature made with another secret, a missing header, or garbage', () => {
    const gateway = createGateway();
    expect(gateway.verifyWebhook(body, header(t, sign(body, t, 'whsec_other')), now)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
    expect(gateway.verifyWebhook(body, undefined, now)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
    expect(gateway.verifyWebhook(body, 'nonsense', now)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects a correctly signed but stale delivery', () => {
    const old = t - 301;
    expect(createGateway().verifyWebhook(body, header(old, sign(body, old)), now)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('rejects everything when no secret is configured', () => {
    expect(
      createGateway({ webhookSecret: '' }).verifyWebhook(body, header(t, sign(body, t)), now)
    ).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('reports a signed body that is not a JSON event as invalid_body', () => {
    const notJson = Buffer.from('not json');
    expect(createGateway().verifyWebhook(notJson, header(t, sign(notJson, t)), now)).toEqual({
      ok: false,
      reason: 'invalid_body',
    });
  });
});
