import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const UNSIGNED_FIELDS = new Set(['sign', 'sign_type', 'signType']);
export const EPAY_ORDER_ID_PATTERN = /^EP[0-9a-f]{30}$/;

/** 新供应商独立的本地订单命名空间；旧单不能被发送到新供应商。 */
export function createEpayOrderId(): string {
  return `EP${randomBytes(15).toString('hex')}`;
}

export function isEpayOrderId(id: string): boolean {
  return EPAY_ORDER_ID_PATTERN.test(id);
}

export function signEpay(fields: Readonly<Record<string, string>>, secret: string): string {
  const canonical = Object.keys(fields)
    .filter((key) => !UNSIGNED_FIELDS.has(key) && fields[key] !== '')
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('&');
  // 签名前不编码值；密钥直接追加，不能额外插入 &key=。
  return createHash('md5')
    .update(canonical + secret, 'utf8')
    .digest('hex');
}

export function verifyEpaySignature(fields: Record<string, string>, secret: string): boolean {
  if (!secret || !/^[a-fA-F0-9]{32}$/.test(fields.sign ?? '')) return false;
  return timingSafeEqual(
    Buffer.from(signEpay(fields, secret), 'hex'),
    Buffer.from(fields.sign!, 'hex')
  );
}

/** 直接解析原始 query，避免框架在验签前合并重复参数或丢失扩展签名字段。 */
export function parseEpayQuery(rawQuery: string): Record<string, string> | null {
  if (rawQuery.length > 8_192 || /%(?![0-9a-f]{2})/i.test(rawQuery)) return null;
  const fields: Record<string, string> = Object.create(null);
  for (const [key, value] of new URLSearchParams(rawQuery)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ||
      Object.hasOwn(fields, key) ||
      value.length > 2_048 ||
      Object.keys(fields).length >= 40
    )
      return null;
    fields[key] = value;
  }
  return fields;
}

export function httpsPaymentUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** 精确比较人民币分：文档允许第三位小数，但本系统不能把厘四舍五入后入账。 */
export function epayAmountCents(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,3})?$/.test(value)) return NaN;
  const [yuan = '', fraction = ''] = value.split('.');
  if (fraction.length === 3 && fraction[2] !== '0') return NaN;
  const cents = Number(yuan) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : NaN;
}
