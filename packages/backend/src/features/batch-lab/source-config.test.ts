import { describe, expect, it } from 'vitest';
import { resolveBatchLabSourceConfig } from './source-config.js';

const base = {
  nodeEnv: 'test',
  backendEnvironment: 'test' as const,
  sourceEnvironment: 'test' as const,
  testProjectRef: 'zoqelpfhurwehlvypryl',
  prodProjectRef: 'wbtsfzozlmurljvglhpn',
};

describe('resolveBatchLabSourceConfig', () => {
  it('fails closed when the dedicated URI is missing', () => {
    expect(resolveBatchLabSourceConfig({ ...base, env: {} })).toMatchObject({ configured: false });
  });

  it.each([
    'postgresql://postgres:secret@db.zoqelpfhurwehlvypryl.supabase.co:5432/postgres?sslmode=require',
    'postgresql://batch_lab_source_login:secret@db.wbtsfzozlmurljvglhpn.supabase.co:5432/postgres?sslmode=require',
    'https://batch_lab_source_login:secret@db.zoqelpfhurwehlvypryl.supabase.co/postgres',
    'postgresql://batch_lab_source_login:secret@db.zoqelpfhurwehlvypryl.supabase.co:5432/postgres',
    'postgresql://batch_lab_source_login.zoqelpfhurwehlvypryl:secret@attacker.example:5432/postgres?sslmode=require',
  ])('rejects an unsafe or mismatched URI without returning it: %s', (connectionString) => {
    const result = resolveBatchLabSourceConfig({
      ...base,
      env: { BATCH_LAB_SOURCE_DATABASE_URL: connectionString },
    });
    expect(result).toMatchObject({ configured: false });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('accepts only the dedicated role on the configured test ref', () => {
    const result = resolveBatchLabSourceConfig({
      ...base,
      env: {
        BATCH_LAB_SOURCE_DATABASE_URL:
          'postgresql://batch_lab_source_login:secret@db.zoqelpfhurwehlvypryl.supabase.co:5432/postgres?sslmode=require',
        BATCH_LAB_SOURCE_CONNECT_TIMEOUT_MS: '4000',
        BATCH_LAB_SOURCE_MAX_CONNECTIONS: '3',
      },
    });
    expect(result).toMatchObject({
      configured: true,
      environment: 'test',
      projectRef: 'zoqelpfhurwehlvypryl',
      connectionTimeoutMs: 4000,
      maxConnections: 3,
    });
  });

  it('accepts the dedicated role with a project suffix for a Supabase pooler', () => {
    const result = resolveBatchLabSourceConfig({
      ...base,
      env: {
        BATCH_LAB_SOURCE_DATABASE_URL:
          'postgresql://batch_lab_source_login.zoqelpfhurwehlvypryl:secret@aws-0-region.pooler.supabase.com:6543/postgres?sslmode=require',
      },
    });
    expect(result).toMatchObject({ configured: true, projectRef: 'zoqelpfhurwehlvypryl' });
  });

  it('allows a non-TLS local development test source for poolers that reset TLS handshakes', () => {
    const result = resolveBatchLabSourceConfig({
      ...base,
      nodeEnv: 'development',
      env: {
        BATCH_LAB_SOURCE_DATABASE_URL:
          'postgresql://batch_lab_source_login.zoqelpfhurwehlvypryl:secret@aws-0-region.pooler.supabase.com:5432/postgres',
      },
    });
    expect(result).toMatchObject({ configured: true, projectRef: 'zoqelpfhurwehlvypryl' });
  });

  it('requires both a production backend and an explicit production allow flag', () => {
    const connectionString =
      'postgresql://batch_lab_source_login:secret@db.wbtsfzozlmurljvglhpn.supabase.co:5432/postgres?sslmode=require';
    const sourceEnvironment = 'production' as const;
    expect(
      resolveBatchLabSourceConfig({
        ...base,
        sourceEnvironment,
        env: { BATCH_LAB_SOURCE_DATABASE_URL: connectionString },
      })
    ).toMatchObject({ configured: false });
    expect(
      resolveBatchLabSourceConfig({
        ...base,
        backendEnvironment: 'production',
        sourceEnvironment,
        env: { BATCH_LAB_SOURCE_DATABASE_URL: connectionString },
      })
    ).toMatchObject({ configured: false });
    expect(
      resolveBatchLabSourceConfig({
        ...base,
        backendEnvironment: 'production',
        sourceEnvironment,
        env: {
          BATCH_LAB_SOURCE_DATABASE_URL: connectionString,
          BATCH_LAB_ALLOW_PRODUCTION_SOURCE: 'true',
        },
      })
    ).toMatchObject({ configured: true, environment: 'production' });
  });
});
