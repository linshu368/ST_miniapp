/**
 * backend / lib / llm-token.ts
 *
 * JWT platformToken 签发与验签（HS256，Node 原生 crypto）。
 *
 * 用途：provision 时为每个用户签发 token，写入 secrets.json 替代真实 API key。
 * LLM proxy 收到 ST 请求后验签 + 提取 userId，再用平台真实 key 转发上游。
 *
 * 密钥：LLM_PROXY_TOKEN_SECRET（仅 backend 持有）。
 */

import { createHmac } from 'node:crypto';

function getTokenSecret(): string {
  return process.env.LLM_PROXY_TOKEN_SECRET || process.env.ST_USER_PASSWORD_SECRET || '';
}

interface ProductionPlatformTokenPayload {
  userId: string;
  iat: number;
  ver: 1;
}

interface SimulationPlatformTokenPayload {
  mode: 'simulation';
  conversationId: string;
  iat: number;
  exp: number;
  ver: 2;
}

export type PlatformTokenContext =
  | { mode: 'production'; userId: string }
  | { mode: 'simulation'; conversationId: string };

function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return buf.toString('base64url');
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf-8');
}

function hmacSign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

/**
 * 签发 platformToken（JWT HS256）。
 * 仅 backend 进程调用（internal endpoint / bridge 首登流程）。
 */
export function signPlatformToken(userId: string): string {
  const secret = getTokenSecret();
  if (!secret) {
    throw new Error('LLM_PROXY_TOKEN_SECRET 未配置，无法签发 platformToken');
  }

  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload: ProductionPlatformTokenPayload = {
    userId,
    iat: Math.floor(Date.now() / 1000),
    ver: 1,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = hmacSign(`${header}.${payloadB64}`, secret);

  return `${header}.${payloadB64}.${signature}`;
}

/**
 * 验签 platformToken，返回 userId。
 * 签名不匹配或格式异常时返回 null（不抛异常，由调用方决定返回码）。
 */
export function verifyPlatformTokenContext(token: string): PlatformTokenContext | null {
  const secret = getTokenSecret();
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payloadB64, signature] = parts as [string, string, string];
  const expectedSig = hmacSign(`${header}.${payloadB64}`, secret);

  if (signature.length !== expectedSig.length) return null;
  const sigBuf = Buffer.from(signature, 'base64url');
  const expBuf = Buffer.from(expectedSig, 'base64url');
  if (sigBuf.length !== expBuf.length) return null;

  let diff = 0;
  for (let i = 0; i < sigBuf.length; i++) {
    diff |= (sigBuf[i] ?? 0) ^ (expBuf[i] ?? 0);
  }
  if (diff !== 0) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as
      | ProductionPlatformTokenPayload
      | SimulationPlatformTokenPayload;
    if (payload.ver === 1 && payload.userId) {
      return { mode: 'production', userId: payload.userId };
    }
    if (
      payload.ver === 2 &&
      payload.mode === 'simulation' &&
      payload.conversationId &&
      Number.isFinite(payload.exp) &&
      payload.exp >= Math.floor(Date.now() / 1000)
    ) {
      return { mode: 'simulation', conversationId: payload.conversationId };
    }
    return null;
  } catch {
    return null;
  }
}

export function verifyPlatformToken(token: string): string | null {
  const context = verifyPlatformTokenContext(token);
  return context?.mode === 'production' ? context.userId : null;
}
