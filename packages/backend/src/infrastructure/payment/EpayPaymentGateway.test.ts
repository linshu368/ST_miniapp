import { afterEach, describe, expect, it, vi } from 'vitest';
import { EpayPaymentGateway } from './EpayPaymentGateway.js';
import {
  createEpayOrderId,
  epayAmountCents,
  parseEpayQuery,
  signEpay,
  verifyEpaySignature,
} from './epay-protocol.js';
import { postEpayForm } from './epay-http.js';

const id = 'EP' + 'a'.repeat(30);
const key = 'fixture-key';
const gateway = new EpayPaymentGateway({
  baseUrl: 'https://provider.example/api',
  appId: '1001',
  appKey: key,
  notifyUrl: 'https://backend.example/api/payment/notify/ttzf',
  returnUrl: 'https://backend.example/api/payment/return',
});
const target = { id, provider_transaction_id: null, payment_type: 'wxpay' as const };
const paid = {
  code: 1,
  pid: 1001,
  trade_no: '202611091234',
  out_trade_no: id,
  type: 'wxpay',
  money: '6.000',
  status: 1,
};
const createInput = {
  orderId: id,
  amount: '6.00',
  type: 'wxpay' as const,
  description: '星尘 + &',
  clientIp: '203.0.113.10',
};
function respond(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe('epay protocol', () => {
  it('uses the documented lowercase MD5 over raw sorted values, excluding only unsigned and empty fields', () => {
    const fields = {
      name: '星尘',
      a: 'hello +',
      A: 'zero',
      c: '0',
      empty: '',
      sign_type: 'MD5',
      signType: 'MD5',
      sign: 'ignored',
    };
    // Independently calculated from UTF-8 "A=zero&a=hello +&c=0&name=星尘fixture-key".
    const signature = '06ea8abd51cf387265f3fb458c5a3130';
    expect(signEpay(fields, key)).toBe(signature);
    expect(verifyEpaySignature({ ...fields, sign: signature }, key)).toBe(true);
    expect(verifyEpaySignature({ ...fields, c: '1', sign: signature }, key)).toBe(false);
    expect(verifyEpaySignature({ ...fields, sign: 'x' }, key)).toBe(false);
  });
  it('decodes values exactly once and rejects ambiguous duplicate or malformed keys', () => {
    expect(parseEpayQuery('name=%E6%98%9F%E5%B0%98+%2B%26&param=%2520')).toEqual({
      name: '星尘 +&',
      param: '%20',
    });
    for (const query of [
      'pid=1&pid=1',
      'pid=1&%70id=1',
      'name=%Q0',
      'pid[]=1',
      'a=' + 'x'.repeat(9000),
    ]) {
      expect(parseEpayQuery(query)).toBeNull();
    }
  });
  it('compares cents exactly without rounding fractional cents', () => {
    for (const amount of ['6', '6.0', '6.00', '6.000']) expect(epayAmountCents(amount)).toBe(600);
    for (const amount of ['6.001', '6.009', '6e0', ' 6', '-6', '6.0000'])
      expect(epayAmountCents(amount)).toBeNaN();
    expect(createEpayOrderId()).toMatch(/^EP[0-9a-f]{30}$/);
    expect(createEpayOrderId()).not.toBe(createEpayOrderId());
  });
});

describe('epay create and query', () => {
  it.each(['alipay', 'wxpay'] as const)(
    'creates %s with signed fields and trusted client IP without param',
    async (type) => {
      const fetchMock = respond({
        code: 1,
        trade_no: '202611091234',
        payurl: 'https://checkout.example/order',
      });
      expect(await gateway.createPayment({ ...createInput, type })).toEqual({
        success: true,
        paymentUrl: 'https://checkout.example/order',
        providerTransactionId: '202611091234',
      });
      const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://provider.example/api/epay/mapi.php');
      expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
      const form = Object.fromEntries(new URLSearchParams(options.body as string));
      expect(form).toMatchObject({
        pid: '1001',
        type,
        out_trade_no: id,
        clientip: '203.0.113.10',
        name: '星尘 + &',
        money: '6.00',
      });
      expect(form.return_url).toContain(`order_id=${id}`);
      expect(form).not.toHaveProperty('param');
      expect(verifyEpaySignature(form, key)).toBe(true);
      expect(url).not.toContain(key);
    }
  );
  it.each([
    { code: 1, trade_no: 'x', qrcode: 'https://checkout.example/qr' },
    { code: 1, trade_no: 'x', payurl: 'javascript:alert(1)' },
    { code: 1, trade_no: 'x', payurl: 'https://user:pass@checkout.example' },
    { code: 1, payurl: 'https://checkout.example' },
  ])('keeps unsupported checkout responses recoverable: %j', async (body) => {
    respond(body);
    expect(await gateway.createPayment(createInput)).toMatchObject({
      success: false,
      outcomeUnknown: true,
    });
  });
  it('does not blindly retry ambiguous network failures or expose upstream messages', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('sensitive upstream content');
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await gateway.createPayment(createInput)).toMatchObject({
      success: false,
      outcomeUnknown: true,
      errorClass: 'network',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    respond({ code: -1, msg: 'sensitive upstream content' });
    const result = await gateway.createPayment(createInput);
    expect(result).toMatchObject({ success: false, outcomeUnknown: false });
    expect(JSON.stringify(result)).not.toContain('sensitive upstream content');
  });
  it('queries by merchant ID using the explicitly selected GET protocol', async () => {
    const fetchMock = respond(paid);
    expect(await gateway.queryOrder(target)).toEqual({
      success: true,
      paid: true,
      amount: '6.000',
      tradeNo: paid.trade_no,
      status: 'completed',
    });
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestUrl = new URL(url);
    expect(requestUrl.origin + requestUrl.pathname).toBe(
      'https://provider.example/api/epay/api.php'
    );
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
    expect(options.body).toBeUndefined();
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      act: 'order',
      pid: '1001',
      key,
      out_trade_no: id,
    });
  });
  it.each([
    { pid: 1002 },
    { out_trade_no: 'EP' + 'b'.repeat(30) },
    { type: 'alipay' },
    { status: '1' },
    { status: 2 },
    { money: '6.001' },
    { money: 6 },
    { trade_no: '' },
  ])('rejects mismatched or malformed query responses %j', async (overrides) => {
    respond({ ...paid, ...overrides });
    expect(await gateway.queryOrder(target)).toMatchObject({
      success: false,
      errorClass: 'response_invalid',
    });
  });
  it.each(['', 'legacy-environment', null])('ignores optional query param %j', async (param) => {
    respond({ ...paid, param });
    expect(await gateway.queryOrder(target)).toMatchObject({ success: true, paid: true });
  });
  it.each([undefined, null])(
    'accepts missing/null query pid %j with trusted order identity',
    async (pid) => {
      const response = { ...paid, pid, param: null, buyer: null };
      if (pid === undefined) delete response.pid;
      respond(response);
      expect(
        await gateway.queryOrder({ ...target, provider_transaction_id: paid.trade_no })
      ).toMatchObject({
        success: true,
        paid: true,
        amount: paid.money,
        tradeNo: paid.trade_no,
      });
      respond({ ...response, status: 0 });
      expect(await gateway.queryOrder(target)).toMatchObject({ success: true, paid: false });
    }
  );
  it.each([
    { pid: '' },
    { pid: 'null' },
    { pid: '1002' },
    { pid: -1 },
    { pid: true },
    { out_trade_no: 'EP' + 'b'.repeat(30) },
    { type: 'alipay' },
    { money: '6.001' },
    { trade_no: 'different' },
  ])('keeps identity validation when query pid is null: %j', async (overrides) => {
    respond({ ...paid, pid: null, ...overrides });
    expect(
      await gateway.queryOrder({ ...target, provider_transaction_id: paid.trade_no })
    ).toMatchObject({
      success: false,
      errorClass: 'response_invalid',
    });
  });
  it('checks stored provider reference and keeps status 0 nonterminal', async () => {
    respond(paid);
    expect(
      (await gateway.queryOrder({ ...target, provider_transaction_id: 'different' })).success
    ).toBe(false);
    respond({ ...paid, status: 0 });
    expect(await gateway.queryOrder(target)).toMatchObject({
      success: true,
      paid: false,
      status: 'pending',
    });
  });
  it('never sends legacy orders to TTZF and rejects invalid local inputs before network access', async () => {
    const fetchMock = respond(paid);
    expect((await gateway.queryOrder({ ...target, id: 'MA_legacy' })).success).toBe(false);
    expect((await gateway.createPayment({ ...createInput, clientIp: 'not-an-ip' })).success).toBe(
      false
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    [429, 'rate_limited'],
    [503, 'provider_unavailable'],
    [401, 'configuration'],
  ] as const)('classifies HTTP %i without retry', async (status, errorClass) => {
    const fetchMock = respond({}, status);
    expect(await gateway.queryOrder(target)).toMatchObject({ success: false, errorClass });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('epay bounded transport', () => {
  it('applies the deadline while streaming the response, not just until headers arrive', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ReadableStream({ cancel })))
    );
    expect(await postEpayForm('https://provider.example', {}, 20)).toMatchObject({
      success: false,
      errorClass: 'timeout',
    });
    expect(cancel).toHaveBeenCalled();
  });
  it('bounds response size and rejects non-object JSON', async () => {
    respond({ payload: 'x'.repeat(70000) });
    expect(await postEpayForm('https://provider.example', {}, 100)).toMatchObject({
      success: false,
      errorClass: 'response_invalid',
    });
    respond([]);
    expect(await postEpayForm('https://provider.example', {}, 100)).toMatchObject({
      success: false,
      errorClass: 'response_invalid',
    });
  });
  it('honors caller cancellation before sending credentials', async () => {
    const fetchMock = respond(paid);
    expect(await gateway.queryOrder(target, AbortSignal.abort())).toMatchObject({
      success: false,
      errorClass: 'timeout',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
