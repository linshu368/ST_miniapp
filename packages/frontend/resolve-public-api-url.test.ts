import { describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_API_URL,
  PRODUCTION_API_URL,
  resolvePublicApiUrl,
} from './resolve-public-api-url.mjs';

describe('resolvePublicApiUrl', () => {
  it('maps a feature PR onto its own Railway backend even if Preview still has an older PR URL', () => {
    expect(
      resolvePublicApiUrl({
        NEXT_PUBLIC_API_URL: 'https://stminiapp-pr-322.up.railway.app',
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'dev',
        VERCEL_GIT_COMMIT_REF: 'dev_alipay',
        VERCEL_GIT_PULL_REQUEST_ID: '341',
      })
    ).toBe('https://stminiapp-pr-341.up.railway.app');
  });

  it('reads the PR number from a custom Vercel environment name when the Git PR id is missing', () => {
    expect(
      resolvePublicApiUrl({
        NEXT_PUBLIC_API_URL: 'https://stminiapp-pr-322.up.railway.app',
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'pr-341',
        VERCEL_GIT_COMMIT_REF: 'dev_alipay',
      })
    ).toBe('https://stminiapp-pr-341.up.railway.app');
  });

  it('keeps the `dev` branch on development and ignores leftover PR URLs', () => {
    expect(
      resolvePublicApiUrl({
        NEXT_PUBLIC_API_URL: 'https://stminiapp-pr-322.up.railway.app',
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'dev',
        VERCEL_GIT_COMMIT_REF: 'dev',
      })
    ).toBe(DEVELOPMENT_API_URL);
  });

  it('does not let production inherit a Preview PR URL', () => {
    expect(
      resolvePublicApiUrl({
        NEXT_PUBLIC_API_URL: '',
        VERCEL_ENV: 'production',
        VERCEL_GIT_PULL_REQUEST_ID: '341',
      })
    ).toBe(PRODUCTION_API_URL);
  });

  it('keeps local .env.local overrides when Vercel env is absent', () => {
    expect(
      resolvePublicApiUrl({
        NEXT_PUBLIC_API_URL: 'http://localhost:3001',
      })
    ).toBe('http://localhost:3001');
  });
});
