import { Pool } from 'pg';
import { config } from '../../platform/config.js';
import { BATCH_LAB_SOURCE_ROLE } from './source-config.js';

type SourceProbeRow = {
  current_user: string;
  transaction_read_only: string;
  statement_timeout: string;
  lock_timeout: string;
};

export type BatchLabSourceDiagnostic =
  | 'probe: missing-row'
  | 'probe: identity-mismatch'
  | 'probe: read-only-mismatch'
  | 'probe: statement-timeout-mismatch'
  | 'probe: lock-timeout-mismatch';

export class BatchLabSourceProbeError extends Error {
  constructor(readonly diagnostic: BatchLabSourceDiagnostic) {
    super(diagnostic);
    this.name = 'BatchLabSourceProbeError';
  }
}

let sourcePool: Pool | null = null;

export function getBatchLabSourcePool(): Pool {
  const source = config.batchLab.source;
  if (!source.configured) {
    throw new Error(source.reason);
  }
  sourcePool ??= new Pool({
    connectionString: source.connectionString,
    max: source.maxConnections,
    connectionTimeoutMillis: source.connectionTimeoutMs,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  return sourcePool;
}

export async function verifyBatchLabSourceConnection(
  pool = getBatchLabSourcePool()
): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query<SourceProbeRow>(
      `select current_user,
              current_setting('transaction_read_only') as transaction_read_only,
              current_setting('statement_timeout') as statement_timeout,
              current_setting('lock_timeout') as lock_timeout`
    );
    assertSourceProbe(result.rows[0]);
  } finally {
    client.release();
  }
}

export function assertSourceProbe(row: SourceProbeRow | undefined): void {
  if (!row) {
    throw new BatchLabSourceProbeError('probe: missing-row');
  }
  if (row.current_user !== BATCH_LAB_SOURCE_ROLE) {
    throw new BatchLabSourceProbeError('probe: identity-mismatch');
  }
  if (row.transaction_read_only !== 'on') {
    throw new BatchLabSourceProbeError('probe: read-only-mismatch');
  }
  if (!isTimeoutAtMost(row.statement_timeout, 5_000)) {
    throw new BatchLabSourceProbeError('probe: statement-timeout-mismatch');
  }
  if (!isTimeoutAtMost(row.lock_timeout, 500)) {
    throw new BatchLabSourceProbeError('probe: lock-timeout-mismatch');
  }
}

export async function closeBatchLabSourcePool(): Promise<void> {
  const pool = sourcePool;
  sourcePool = null;
  if (pool) await pool.end();
}

function isTimeoutAtMost(value: string, maximumMs: number): boolean {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)$/i);
  if (!match) return false;
  const amount = Number(match[1]);
  const milliseconds = match[2]?.toLowerCase() === 's' ? amount * 1_000 : amount;
  return milliseconds > 0 && milliseconds <= maximumMs;
}
