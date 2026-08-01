import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyPlatformToken, verifyPlatformTokenContext } from './llm-token.js';

const SECRET = 'simulation-token-test-secret';

function sign(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

describe('simulation platform tokens', () => {
  const originalSecret = process.env.LLM_PROXY_TOKEN_SECRET;

  beforeEach(() => {
    process.env.LLM_PROXY_TOKEN_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.LLM_PROXY_TOKEN_SECRET;
    else process.env.LLM_PROXY_TOKEN_SECRET = originalSecret;
  });

  it('returns a simulation context for a valid expiring token', () => {
    const conversationId = '00000000-0000-4000-8000-000000000001';
    const token = sign({
      mode: 'simulation',
      conversationId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      ver: 2,
    });

    expect(verifyPlatformTokenContext(token)).toEqual({
      mode: 'simulation',
      conversationId,
    });
    expect(verifyPlatformToken(token)).toBeNull();
  });

  it('rejects expired simulation tokens', () => {
    const token = sign({
      mode: 'simulation',
      conversationId: '00000000-0000-4000-8000-000000000001',
      iat: 1,
      exp: 2,
      ver: 2,
    });
    expect(verifyPlatformTokenContext(token)).toBeNull();
  });
});
