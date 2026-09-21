import type { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  BatchLabSourceProbeError,
  closeBatchLabSourcePool,
  getBatchLabSourcePool,
  verifyBatchLabSourceConnection,
} from '../features/batch-lab/source-database.js';
import { config } from '../platform/config.js';

type AccessCheck = {
  name: string;
  sql: string;
};

const allowedReadChecks: AccessCheck[] = [
  { name: 'read experience.chat_history', sql: 'select * from experience.chat_history limit 0' },
  { name: 'read experience.chat_sessions', sql: 'select * from experience.chat_sessions limit 0' },
  { name: 'read app_core.characters', sql: 'select * from app_core.characters limit 0' },
];

const deniedStatementChecks: AccessCheck[] = [
  {
    name: 'insert source row',
    sql: 'insert into experience.chat_history select * from experience.chat_history where false',
  },
  {
    name: 'update source row',
    sql: 'update experience.chat_history set id = id where false',
  },
  { name: 'delete source row', sql: 'delete from experience.chat_history where false' },
  { name: 'truncate source table', sql: 'truncate table experience.chat_history' },
  {
    name: 'create source object',
    sql: 'create table experience.batch_lab_forbidden_probe (id integer)',
  },
  {
    name: 'invoke side-effect function',
    sql: "select app_core.increment_user_total_round('00000000-0000-0000-0000-000000000000'::uuid, 1)",
  },
];

const EXPECTED_DENIAL_SQLSTATES = new Set(['25006', '42501']);

export async function main(): Promise<void> {
  let pool: Pool | null = null;
  let failed = false;

  try {
    assertTestTarget();
    const activePool = getBatchLabSourcePool();
    pool = activePool;
    await runPositiveCheck('identity/read-only/timeouts', () =>
      verifyBatchLabSourceConnection(activePool)
    );
    await runPositiveCheck('role attributes and object ACLs', () => verifyAclBoundary(activePool));

    for (const check of allowedReadChecks) {
      await runPositiveCheck(check.name, () => activePool.query(check.sql));
    }
    await runPositiveCheck('sample visibility', () => verifySampleVisibility(activePool));
    for (const check of deniedStatementChecks) {
      await runDeniedCheck(activePool, check);
    }
  } catch {
    failed = true;
  } finally {
    if (pool) await closeBatchLabSourcePool();
  }

  if (failed) {
    console.error(
      'FAIL Batch Lab source access verification; disable LOGIN and remove the secret.'
    );
    process.exitCode = 1;
    return;
  }
  console.log('PASS Batch Lab source access verification');
}

function assertTestTarget(): void {
  const source = config.batchLab.source;
  if (
    config.database.environment !== 'test' ||
    config.batchLab.sourceEnvironment !== 'test' ||
    !source.configured ||
    source.projectRef !== config.database.testProjectRef
  ) {
    throw new Error('Batch Lab source verification is restricted to the configured test project');
  }
}

async function verifyAclBoundary(pool: Pool): Promise<void> {
  const result = await pool.query<{
    role_safe: boolean;
    batch_lab_hidden: boolean;
    source_schema_create_denied: boolean;
    source_selects_exact: boolean;
    source_writes_denied: boolean;
    sequences_denied: boolean;
  }>(`
    select
      exists (
        select 1 from pg_roles
        where rolname = current_user
          and not rolsuper and not rolcreatedb and not rolcreaterole
          and not rolreplication and not rolbypassrls
      ) as role_safe,
      not has_schema_privilege(current_user, 'batch_lab', 'USAGE') as batch_lab_hidden,
      not has_schema_privilege(current_user, 'experience', 'CREATE')
        and not has_schema_privilege(current_user, 'app_core', 'CREATE')
        as source_schema_create_denied,
      not exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('experience', 'app_core')
          and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and has_table_privilege(current_user, c.oid, 'SELECT')
          and format('%I.%I', n.nspname, c.relname) not in (
            'experience.chat_history',
            'experience.chat_sessions',
            'app_core.characters'
          )
      ) as source_selects_exact,
      not exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('experience', 'app_core')
          and c.relkind in ('r', 'p')
          and (
            has_table_privilege(current_user, c.oid, 'INSERT')
            or has_table_privilege(current_user, c.oid, 'UPDATE')
            or has_table_privilege(current_user, c.oid, 'DELETE')
            or has_table_privilege(current_user, c.oid, 'TRUNCATE')
          )
      ) as source_writes_denied,
      not exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('experience', 'app_core')
          and c.relkind = 'S'
          and (
            has_sequence_privilege(current_user, c.oid, 'USAGE')
            or has_sequence_privilege(current_user, c.oid, 'SELECT')
            or has_sequence_privilege(current_user, c.oid, 'UPDATE')
          )
      ) as sequences_denied
  `);
  const row = result.rows[0];
  if (
    !row?.role_safe ||
    !row.batch_lab_hidden ||
    !row.source_schema_create_denied ||
    !row.source_selects_exact ||
    !row.source_writes_denied ||
    !row.sequences_denied
  ) {
    throw new Error('Batch Lab source ACL boundary is unsafe');
  }
}

async function verifySampleVisibility(pool: Pool): Promise<void> {
  const result = await pool.query<{ valid_candidate_count: number }>(`
    select count(*)::int as valid_candidate_count
    from experience.chat_history h
    join experience.chat_sessions s on s.id = h.session_id
    join app_core.characters c on c.id = h.character_id
    where h.user_input is not null
      and btrim(h.user_input) <> ''
      and h.model is not null
      and btrim(h.model) <> ''
      and h.turn_index >= 1
      and h.revision >= 0
      and jsonb_typeof(h.history) = 'array'
      and s.deleted_at is null
    limit 1
  `);
  const count = result.rows[0]?.valid_candidate_count ?? 0;
  if (count < 1) {
    throw new Error('Batch Lab source role cannot see any complete sample candidates');
  }
}

async function runPositiveCheck(name: string, check: () => Promise<unknown>): Promise<void> {
  try {
    await check();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name} [${classifySafeDiagnostic(err)}]${formatSqlState(err)}`);
    throw err;
  }
}

export function classifySafeDiagnostic(err: unknown): string {
  if (err instanceof BatchLabSourceProbeError) return err.diagnostic;
  const code = getErrorCode(err);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'connect: dns';
  if (code === '28P01') return 'connect: authentication';
  if (code === '28000') return 'connect: authorization';
  if (code === 'ETIMEDOUT') return 'connect: timeout';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') {
    return 'connect: network';
  }
  if (
    code?.startsWith('ERR_TLS_') ||
    code?.startsWith('CERT_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  ) {
    return 'connect: tls';
  }
  if (code === '53300') return 'connect: capacity';
  if (code === '57P03') return 'connect: unavailable';
  if (code && /^[0-9A-Z]{5}$/.test(code)) return 'database: rejected';
  return 'connect-or-probe: unknown';
}

export async function runDeniedCheck(pool: Pool, check: AccessCheck): Promise<void> {
  try {
    await pool.query(check.sql);
  } catch (err) {
    if (isExpectedDenial(err)) {
      console.log(`PASS deny ${check.name}${formatSqlState(err)}`);
      return;
    }
    console.error(`FAIL deny ${check.name}${formatSqlState(err)}`);
    throw new Error(`Unexpected source verification failure: ${check.name}`, { cause: err });
  }
  console.error(`FAIL deny ${check.name}`);
  throw new Error(`Unsafe source permission: ${check.name}`);
}

export function isExpectedDenial(err: unknown): boolean {
  const code = getErrorCode(err);
  return code !== null && EXPECTED_DENIAL_SQLSTATES.has(code);
}

function formatSqlState(err: unknown): string {
  const code = getErrorCode(err);
  return code && /^[0-9A-Z]{5}$/.test(code) ? ` [${code}]` : '';
}

function getErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : '';
if (entrypoint === fileURLToPath(import.meta.url)) {
  void main();
}
