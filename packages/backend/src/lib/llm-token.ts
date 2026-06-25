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

const LLM_PROXY_TOKEN_SECRET = process.env.LLM_PROXY_TOKEN_SECRET || '';

interface PlatformTokenPayload {
  userId: string;
  iat: number;
  ver: 1;
}

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
  if (!LLM_PROXY_TOKEN_SECRET) {
    throw new Error('LLM_PROXY_TOKEN_SECRET 未配置，无法签发 platformToken');
  }

  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload: PlatformTokenPayload = { userId, iat: Math.floor(Date.now() / 1000), ver: 1 };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = hmacSign(`${header}.${payloadB64}`, LLM_PROXY_TOKEN_SECRET);

  return `${header}.${payloadB64}.${signature}`;
}

/**
 * 验签 platformToken，返回 userId。
 * 签名不匹配或格式异常时返回 null（不抛异常，由调用方决定返回码）。
 */
export function verifyPlatformToken(token: string): string | null {
  if (!LLM_PROXY_TOKEN_SECRET) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payloadB64, signature] = parts as [string, string, string];
  const expectedSig = hmacSign(`${header}.${payloadB64}`, LLM_PROXY_TOKEN_SECRET);

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
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as PlatformTokenPayload;
    if (!payload.userId || payload.ver !== 1) return null;
    return payload.userId;
  } catch {
    return null;
  }
}
