import { describe, expect, it } from 'vitest';
import { normalizeEmptyLogoutRequest, resolveAdminTestApiUrl } from './environment';
import { assertAdminPreviewApiUrl, resolveAdminPreviewApiUrl } from './preview-api';

describe('resolveAdminPreviewApiUrl', () => {
  it('binds a Vercel pull-request Preview to its deterministic Railway backend', () => {
    expect(
      resolveAdminPreviewApiUrl({
        configuredTestApiUrl: 'https://stminiapp-development.up.railway.app',
        vercelEnv: 'preview',
        pullRequestId: '364',
        gitCommitRef: 'codex/feature-branch',
      })
    ).toBe('https://stminiapp-pr-364.up.railway.app');
  });

  it('uses stable TEST for the dev-to-main release PR', () => {
    expect(
      resolveAdminPreviewApiUrl({
        configuredTestApiUrl: 'https://stminiapp-development.up.railway.app',
        vercelEnv: 'preview',
        pullRequestId: '391',
        gitCommitRef: 'dev',
      })
    ).toBe('https://stminiapp-development.up.railway.app');
  });

  it('uses stable TEST for a branch Preview without pull-request metadata', () => {
    expect(
      resolveAdminPreviewApiUrl({
        configuredTestApiUrl: 'https://stminiapp-development.up.railway.app',
        vercelEnv: 'preview',
        pullRequestId: undefined,
        gitCommitRef: 'dev',
      })
    ).toBe('https://stminiapp-development.up.railway.app');
  });

  it('does not treat malformed pull-request metadata as a Railway origin', () => {
    expect(
      resolveAdminPreviewApiUrl({
        configuredTestApiUrl: 'https://stminiapp-development.up.railway.app',
        vercelEnv: 'preview',
        pullRequestId: '364/main',
        gitCommitRef: 'codex/feature-branch',
      })
    ).toBe('https://stminiapp-development.up.railway.app');
  });

  it('fails an unconfigured branch Preview instead of falling back to Production', () => {
    expect(() =>
      assertAdminPreviewApiUrl({
        configuredTestApiUrl: '',
        vercelEnv: 'preview',
        pullRequestId: undefined,
        gitCommitRef: 'dev',
      })
    ).toThrow('VITE_ADMIN_TEST_API_URL');
  });

  it('rejects a non-HTTPS Preview API URL', () => {
    expect(() =>
      assertAdminPreviewApiUrl({
        configuredTestApiUrl: 'http://stminiapp-development.up.railway.app',
        vercelEnv: 'preview',
        pullRequestId: undefined,
        gitCommitRef: 'dev',
      })
    ).toThrow('HTTPS');
  });
});

describe('resolveAdminTestApiUrl', () => {
  it('uses the PR Preview backend when Vite injected one', () => {
    expect(
      resolveAdminTestApiUrl(
        'https://stminiapp-development.up.railway.app',
        'https://stminiapp-pr-364.up.railway.app'
      )
    ).toBe('https://stminiapp-pr-364.up.railway.app');
  });

  it('keeps the configured backend outside a PR Preview', () => {
    expect(resolveAdminTestApiUrl('https://stminiapp-development.up.railway.app', '')).toBe(
      'https://stminiapp-development.up.railway.app'
    );
  });
});

describe('normalizeEmptyLogoutRequest', () => {
  it('adds an empty JSON object to proxied logout requests', () => {
    const init = normalizeEmptyLogoutRequest(
      'https://api.example.com/api/admin/supabase/auth/v1/logout?scope=global',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }
    );
    expect(init?.body).toBe('{}');
  });

  it('does not alter normal API requests', () => {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    };
    expect(normalizeEmptyLogoutRequest('https://api.example.com/rest/v1/rpc/test', init)).toBe(
      init
    );
  });
});
