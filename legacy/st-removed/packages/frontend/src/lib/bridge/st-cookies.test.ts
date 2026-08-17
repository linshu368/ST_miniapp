import { describe, expect, it } from 'vitest';
import {
  buildExpireSetCookieHeaders,
  isStSessionCookieName,
  parseCookiePairs,
  pickStSessionPairs,
} from './st-cookies';

describe('isStSessionCookieName', () => {
  it('accepts ST cookie-session names', () => {
    expect(isStSessionCookieName('session')).toBe(true);
    expect(isStSessionCookieName('session.sig')).toBe(true);
    expect(isStSessionCookieName('session-0671b3bc')).toBe(true);
    expect(isStSessionCookieName('session-0671b3bc.sig')).toBe(true);
  });

  it('rejects unrelated cookies', () => {
    expect(isStSessionCookieName('sentry-sc')).toBe(false);
    expect(isStSessionCookieName('_vercel_session')).toBe(false);
    expect(isStSessionCookieName('session-toolong12')).toBe(false);
    expect(isStSessionCookieName('AMP_ba62b82db2')).toBe(false);
  });
});

describe('pickStSessionPairs', () => {
  it('keeps only whitelisted session pairs', () => {
    const pairs = pickStSessionPairs(
      'session-0671b3bc=abc; session-0671b3bc.sig=def; csrf-token=nope; Path=/'
    );
    expect(pairs.map((p) => p.name)).toEqual(['session-0671b3bc', 'session-0671b3bc.sig']);
  });
});

describe('buildExpireSetCookieHeaders', () => {
  it('expires orphan session cookies but keeps the active ones', () => {
    const { headers, orphanTotal, orphanExpired } = buildExpireSetCookieHeaders(
      'session-aaaa1111=old; session-aaaa1111.sig=oldsig; session-bbbb2222=cur; session-bbbb2222.sig=cursig; sentry-sc=x',
      ['session-bbbb2222', 'session-bbbb2222.sig']
    );

    const joined = headers.join('\n');
    expect(joined).toContain('session-aaaa1111=; Path=/; Max-Age=0');
    expect(joined).toContain('session-aaaa1111.sig=; Path=/; Max-Age=0');
    expect(joined).not.toContain('session-bbbb2222=;');
    expect(joined).not.toContain('sentry-sc=;');
    expect(orphanTotal).toBe(2);
    expect(orphanExpired).toBe(2);
  });

  it('caps orphan expiry so response Set-Cookie stays within platform limits', () => {
    const many = Array.from({ length: 40 }, (_, i) => {
      const hex = i.toString(16).padStart(8, '0');
      return `session-${hex}=v; session-${hex}.sig=s`;
    }).join('; ');

    const { headers, orphanTotal, orphanExpired } = buildExpireSetCookieHeaders(many, [], {
      maxOrphans: 16,
    });

    expect(orphanTotal).toBe(80);
    expect(orphanExpired).toBe(16);
    // 16 names × 3 attribute variants
    expect(headers).toHaveLength(48);
  });

  it('parses empty cookie header safely', () => {
    expect(buildExpireSetCookieHeaders(null, [])).toEqual({
      headers: [],
      orphanTotal: 0,
      orphanExpired: 0,
    });
    expect(parseCookiePairs('')).toEqual([]);
  });
});
