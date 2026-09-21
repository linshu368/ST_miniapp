import { extractSupabaseProjectRef, type DatabaseEnvironment } from '@miniapp/shared';

export const BATCH_LAB_SOURCE_ROLE = 'batch_lab_source_login';

type SourceEnvironment = 'test' | 'production';
type Env = Record<string, string | undefined>;

export type BatchLabSourceConfig =
  | { configured: false; reason: string }
  | {
      configured: true;
      connectionString: string;
      environment: SourceEnvironment;
      projectRef: string;
      connectionTimeoutMs: number;
      maxConnections: number;
    };

export function resolveBatchLabSourceConfig(input: {
  env: Env;
  nodeEnv: string;
  backendEnvironment: DatabaseEnvironment;
  sourceEnvironment: SourceEnvironment;
  testProjectRef: string;
  prodProjectRef: string;
}): BatchLabSourceConfig {
  const connectionString = input.env.BATCH_LAB_SOURCE_DATABASE_URL?.trim();
  if (!connectionString) {
    return unavailable('Batch Lab source database URL is not configured');
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return unavailable('Batch Lab source database URL is invalid');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return unavailable('Batch Lab source database URL must use PostgreSQL');
  }
  const isDevelopmentTestSource =
    input.nodeEnv === 'development' && input.sourceEnvironment === 'test';
  if (url.searchParams.get('sslmode') !== 'require' && !isDevelopmentTestSource) {
    return unavailable('Batch Lab source database URL must require TLS');
  }
  let username: string;
  try {
    username = decodeURIComponent(url.username);
  } catch {
    return unavailable('Batch Lab source database username is invalid');
  }
  const usernameParts = username.split('.');
  if (usernameParts[0] !== BATCH_LAB_SOURCE_ROLE || usernameParts.length > 2) {
    return unavailable('Batch Lab source database must use the dedicated read-only role');
  }

  const projectRef = extractSupabaseProjectRef(connectionString) ?? usernameParts[1] ?? null;
  const expectedRef =
    input.sourceEnvironment === 'production' ? input.prodProjectRef : input.testProjectRef;
  if (!projectRef || projectRef !== expectedRef) {
    return unavailable(
      'Batch Lab source database project does not match the configured environment'
    );
  }
  const isDirectHost = url.hostname === `db.${expectedRef}.supabase.co`;
  const isPoolerHost =
    url.hostname.endsWith('.pooler.supabase.com') && usernameParts[1] === expectedRef;
  if (!isDirectHost && !isPoolerHost) {
    return unavailable('Batch Lab source database host is not an approved Supabase endpoint');
  }

  if (input.sourceEnvironment === 'production') {
    if (input.backendEnvironment !== 'production') {
      return unavailable('A non-production backend cannot use the production Batch Lab source');
    }
    if (!isEnabled(input.env.BATCH_LAB_ALLOW_PRODUCTION_SOURCE)) {
      return unavailable('Production Batch Lab source access is not explicitly allowed');
    }
  }

  return {
    configured: true,
    connectionString,
    environment: input.sourceEnvironment,
    projectRef,
    connectionTimeoutMs: parseBoundedInteger(
      input.env.BATCH_LAB_SOURCE_CONNECT_TIMEOUT_MS,
      3_000,
      500,
      10_000
    ),
    maxConnections: parseBoundedInteger(input.env.BATCH_LAB_SOURCE_MAX_CONNECTIONS, 2, 1, 5),
  };
}

function unavailable(reason: string): BatchLabSourceConfig {
  return { configured: false, reason };
}

function isEnabled(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
