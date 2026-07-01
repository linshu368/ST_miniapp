import '../platform/config.js';
import { createHash } from 'crypto';
import { config } from '../platform/config.js';

interface CliArgs {
  orderId?: string;
  amount?: string;
  tradeNo?: string;
  url?: string;
}

const args = parseArgs(process.argv.slice(2));

if (!args.orderId || !args.amount) {
  console.error(
    'Usage: pnpm --filter @miniapp/backend payment:fake-webhook -- --order-id <ORDER_ID> --amount <CNY_AMOUNT> [--url http://localhost:3001/api/payment/webhook/jlpay]'
  );
  process.exit(1);
}

if (!config.payment.merchantId || !config.payment.merchantKey) {
  console.error('PAYMENT_MERCHANT_ID and PAYMENT_MERCHANT_KEY are required.');
  process.exit(1);
}

const targetUrl = args.url ?? 'http://localhost:3001/api/payment/webhook/jlpay';
const payload: Record<string, string> = {
  pid: config.payment.merchantId,
  trade_no: args.tradeNo ?? `FAKE_${Date.now()}`,
  out_trade_no: args.orderId,
  type: 'alipay',
  name: 'MiniApp fake payment',
  money: normalizeAmount(args.amount),
  trade_status: 'TRADE_SUCCESS',
  sign_type: 'MD5',
};
payload.sign = sign(payload, config.payment.merchantKey);

const response = await fetch(targetUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(payload),
});

const text = await response.text();
console.log(`Webhook URL: ${targetUrl}`);
console.log(`Order ID: ${args.orderId}`);
console.log(`HTTP ${response.status}: ${text}`);

if (!response.ok || text.trim() !== 'success') {
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) continue;

    if (key === '--order-id') parsed.orderId = value;
    if (key === '--amount') parsed.amount = value;
    if (key === '--trade-no') parsed.tradeNo = value;
    if (key === '--url') parsed.url = value;
    i += 1;
  }
  return parsed;
}

function normalizeAmount(amount: string): string {
  const parsed = Number.parseFloat(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  return parsed.toFixed(2);
}

function sign(params: Record<string, string>, merchantKey: string): string {
  const sortedKeys = Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key])
    .sort();
  const source = sortedKeys.map((key) => `${key}=${params[key]}`).join('&') + merchantKey;
  return createHash('md5').update(source).digest('hex');
}
