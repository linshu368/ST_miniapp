import { Client } from 'pg';

type LockRow = { locked?: boolean; unlocked?: boolean };

export interface SessionAdvisoryLockClient {
  connect(): Promise<unknown>;
  query(query: string, values: number[]): Promise<{ rows: LockRow[] }>;
  end(): Promise<void>;
}

export type SessionAdvisoryLockClientFactory = () => SessionAdvisoryLockClient;

export type AdvisoryLeaseResult<T> = { acquired: true; value: T } | { acquired: false };

export type AdvisoryLeaseOptions = {
  createClient?: SessionAdvisoryLockClientFactory;
  onCleanupError?: (stage: 'unlock' | 'close', err: unknown) => void;
};

const CONNECTION_TIMEOUT_MS = 8_000;
const QUERY_TIMEOUT_MS = 8_000;

/**
 * Keeps a session-level PostgreSQL lock on one direct database connection.
 *
 * DATABASE_URL is a pooler endpoint in production, so it cannot safely own a
 * session-level lock across separate queries. DIRECT_URL bypasses that pooler;
 * the client is deliberately short-lived and always closed after one round.
 */
export async function withSessionAdvisoryLock<T>(
  key: number,
  work: () => Promise<T>,
  options: AdvisoryLeaseOptions = {}
): Promise<AdvisoryLeaseResult<T>> {
  const client = (options.createClient ?? createDirectClient)();
  let connected = false;
  let acquired = false;
  let primaryError: unknown;

  try {
    await client.connect();
    connected = true;
    const lock = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key]);
    if (lock.rows[0]?.locked !== true) return { acquired: false };

    acquired = true;
    return { acquired: true, value: await work() };
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    if (connected && acquired) {
      try {
        const unlock = await client.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [
          key,
        ]);
        if (unlock.rows[0]?.unlocked !== true) {
          throw new Error('payment alert advisory lock was not released by its owning session');
        }
      } catch (err) {
        options.onCleanupError?.('unlock', err);
        if (primaryError === undefined) throw err;
      }
    }

    if (connected) {
      try {
        await client.end();
      } catch (err) {
        options.onCleanupError?.('close', err);
        if (primaryError === undefined) throw err;
      }
    }
  }
}

function createDirectClient(): SessionAdvisoryLockClient {
  const connectionString = process.env.DIRECT_URL;
  if (!connectionString) {
    throw new Error('DIRECT_URL 未配置，支付告警 Worker 无法建立专用 advisory lock 连接');
  }
  return new Client({
    connectionString,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    application_name: 'payment-alert-monitor-lease',
  });
}
