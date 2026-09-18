import {
  BATCH_LAB_MAX_PREVIEW_BYTES,
  BATCH_LAB_MAX_SAMPLE_LIMIT,
  type BatchLabErrorCode,
  type BatchLabSqlParameterValue,
} from '@miniapp/shared';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { getBatchLabSourcePool } from './source-database.js';

const ALLOWED_RELATIONS = new Set([
  'experience.chat_history',
  'experience.chat_sessions',
  'app_core.characters',
]);
const FORBIDDEN_KEYWORDS = new Set([
  'alter',
  'call',
  'copy',
  'create',
  'delete',
  'do',
  'drop',
  'execute',
  'grant',
  'insert',
  'into',
  'lock',
  'merge',
  'prepare',
  'revoke',
  'set',
  'truncate',
  'update',
  'vacuum',
]);
const NON_FUNCTION_TOKENS = new Set([
  'and',
  'as',
  'case',
  'exists',
  'from',
  'having',
  'in',
  'join',
  'not',
  'on',
  'or',
  'select',
  'when',
  'where',
  'with',
]);

export interface CompiledBatchLabSourceSql {
  text: string;
  values: BatchLabSqlParameterValue[];
}

export interface BatchLabSourceQueryResult<Row extends QueryResultRow = QueryResultRow> {
  rows: Row[];
  truncated: boolean;
  snapshotBytes: number;
}

export class BatchLabSourceQueryError extends Error {
  constructor(
    readonly code: BatchLabErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'BatchLabSourceQueryError';
  }
}

/**
 * Compiles the intentionally small Batch Lab SQL subset. Parameter values never enter SQL text,
 * while lexical validation prevents comments or quoted text from disguising a second statement.
 */
export function compileBatchLabSourceSql(
  sql: string,
  parameters: Record<string, BatchLabSqlParameterValue>
): CompiledBatchLabSourceSql {
  const scanned = scanSql(sql);
  validateStatement(
    scanned.tokens,
    scanned.semicolons,
    scanned.hasDollarQuote,
    scanned.hasQuotedIdentifier
  );

  const names = [...new Set(scanned.parameters)];
  const supplied = Object.keys(parameters);
  if (
    names.some((name) => !(name in parameters)) ||
    supplied.some((name) => !names.includes(name))
  ) {
    throw invalidSql('SQL parameters do not match the template');
  }

  const positions = new Map(names.map((name, index) => [name, index + 1]));
  return {
    text: scanned.sqlWithParameters.replace(
      /\u0000([A-Za-z_][A-Za-z0-9_]*)\u0000/g,
      (_, name: string) => {
        const position = positions.get(name);
        if (!position) throw invalidSql('SQL parameter is missing');
        return `$${position}`;
      }
    ),
    values: names.map((name) => parameters[name] as BatchLabSqlParameterValue),
  };
}

export async function executeBatchLabSourceQuery<Row extends QueryResultRow = QueryResultRow>(
  compiled: CompiledBatchLabSourceSql,
  sampleLimit: number,
  pool?: Pick<Pool, 'connect'>
): Promise<BatchLabSourceQueryResult<Row>> {
  if (
    !Number.isInteger(sampleLimit) ||
    sampleLimit < 1 ||
    sampleLimit > BATCH_LAB_MAX_SAMPLE_LIMIT
  ) {
    throw new BatchLabSourceQueryError('BATCH_LAB_CAPACITY_EXCEEDED', 'Sample limit is invalid');
  }

  let client: PoolClient | undefined;
  try {
    client = await (pool ?? getBatchLabSourcePool()).connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '500ms'");
    const result = await client.query<Row>(
      `SELECT * FROM (${compiled.text}) AS batch_lab_source_preview LIMIT ${sampleLimit + 1}`,
      compiled.values
    );
    const truncated = result.rows.length > sampleLimit;
    const rows = result.rows.slice(0, sampleLimit);
    const snapshotBytes = measureRows(rows);
    await client.query('COMMIT');
    return { rows, truncated, snapshotBytes };
  } catch (err) {
    if (client) await rollbackQuietly(client);
    if (err instanceof BatchLabSourceQueryError) throw err;
    throw mapQueryError(err);
  } finally {
    client?.release();
  }
}

interface ScanResult {
  tokens: string[];
  parameters: string[];
  semicolons: number[];
  sqlWithParameters: string;
  hasDollarQuote: boolean;
  hasQuotedIdentifier: boolean;
}

function scanSql(sql: string): ScanResult {
  const tokens: string[] = [];
  const parameters: string[] = [];
  const semicolons: number[] = [];
  let output = '';
  let index = 0;
  let state: 'code' | 'single' | 'double' | 'line-comment' | 'block-comment' = 'code';
  let hasDollarQuote = false;
  let hasQuotedIdentifier = false;

  while (index < sql.length) {
    const char = sql[index] as string;
    const next = sql[index + 1];
    if (state === 'line-comment') {
      output += char;
      if (char === '\n') state = 'code';
      index += 1;
      continue;
    }
    if (state === 'block-comment') {
      output += char;
      if (char === '*' && next === '/') {
        output += '/';
        index += 2;
        state = 'code';
      } else index += 1;
      continue;
    }
    if (state === 'single' || state === 'double') {
      output += char;
      const quote = state === 'single' ? "'" : '"';
      if (char === quote && next === quote) {
        output += next;
        index += 2;
      } else {
        if (char === quote) state = 'code';
        index += 1;
      }
      continue;
    }
    if (char === '-' && next === '-') {
      output += '--';
      index += 2;
      state = 'line-comment';
      continue;
    }
    if (char === '/' && next === '*') {
      output += '/*';
      index += 2;
      state = 'block-comment';
      continue;
    }
    if (char === "'" || char === '"') {
      output += char;
      state = char === "'" ? 'single' : 'double';
      if (char === '"') hasQuotedIdentifier = true;
      index += 1;
      continue;
    }
    if (char === '$') hasDollarQuote = true;
    if (char === ';') semicolons.push(index);
    const braceParameter = sql.slice(index).match(/^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/);
    if (braceParameter) {
      const parameterName = braceParameter[1];
      if (!parameterName) throw invalidSql('SQL parameter placeholder is invalid');
      parameters.push(parameterName);
      output += `\u0000${parameterName}\u0000`;
      index += braceParameter[0].length;
      continue;
    }
    if (char === '{' && next === '{') throw invalidSql('SQL parameter placeholder is invalid');
    const colonParameter = sql.slice(index).match(/^:([A-Za-z_][A-Za-z0-9_]*)/);
    if (colonParameter && sql[index - 1] !== ':' && sql[index + 1] !== ':') {
      const parameterName = colonParameter[1];
      if (!parameterName) throw invalidSql('SQL parameter placeholder is invalid');
      parameters.push(parameterName);
      output += `\u0000${parameterName}\u0000`;
      index += colonParameter[0].length;
      continue;
    }
    const identifier = sql.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
    if (identifier) {
      tokens.push(identifier[0].toLowerCase());
      output += identifier[0];
      index += identifier[0].length;
      continue;
    }
    if (char === '(' || char === ')' || char === ',' || char === '.') tokens.push(char);
    output += char;
    index += 1;
  }
  if (state === 'single' || state === 'double' || state === 'block-comment') {
    throw invalidSql('SQL contains an unterminated quote or comment');
  }
  return {
    tokens,
    parameters,
    semicolons,
    sqlWithParameters: output,
    hasDollarQuote,
    hasQuotedIdentifier,
  };
}

function validateStatement(
  tokens: string[],
  semicolons: number[],
  hasDollarQuote: boolean,
  hasQuotedIdentifier: boolean
): void {
  if (
    hasDollarQuote ||
    hasQuotedIdentifier ||
    tokens.length === 0 ||
    !['select', 'with'].includes(tokens[0] as string)
  ) {
    throw invalidSql('Only a single SELECT or WITH query is allowed');
  }
  if (semicolons.length > 0) throw invalidSql('SQL statement separators are not allowed');
  if (tokens.some((token) => FORBIDDEN_KEYWORDS.has(token))) {
    throw invalidSql('SQL contains a forbidden operation');
  }
  const commonTableExpressions = collectCommonTableExpressions(tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (tokens[index + 1] === '(' && /^[a-z_]/.test(token) && !NON_FUNCTION_TOKENS.has(token)) {
      throw invalidSql('Function calls are not allowed');
    }
    if (token !== 'from' && token !== 'join') continue;
    const first = tokens[index + 1];
    const dot = tokens[index + 2];
    const second = tokens[index + 3];
    if (first === '(' || !first || (commonTableExpressions.has(first) && dot !== '.')) continue;
    if (dot !== '.' || !second || !ALLOWED_RELATIONS.has(`${first}.${second}`)) {
      throw invalidSql('SQL references a relation outside the Batch Lab allowlist');
    }
  }
}

function collectCommonTableExpressions(tokens: string[]): Set<string> {
  const names = new Set<string>();
  if (tokens[0] !== 'with') return names;
  for (let index = 1; index < tokens.length - 2; index += 1) {
    const name = tokens[index];
    if (name && tokens[index + 1] === 'as' && tokens[index + 2] === '(') names.add(name);
  }
  return names;
}

function measureRows(rows: QueryResultRow[]): number {
  let bytes = 2;
  for (const row of rows) {
    bytes += Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (bytes > BATCH_LAB_MAX_PREVIEW_BYTES) {
      throw new BatchLabSourceQueryError(
        'BATCH_LAB_CAPACITY_EXCEEDED',
        'Preview exceeds the maximum response size'
      );
    }
  }
  return bytes;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original failure; rollback failure is not a safe retry signal.
  }
}

function mapQueryError(err: unknown): BatchLabSourceQueryError {
  const code = isErrorWithCode(err) ? err.code : undefined;
  return new BatchLabSourceQueryError(
    code === '57014' ? 'BATCH_LAB_TIMEOUT' : 'BATCH_LAB_SOURCE_UNAVAILABLE',
    code === '57014' ? 'Batch Lab source query timed out' : 'Batch Lab source query failed',
    { cause: err }
  );
}

function isErrorWithCode(value: unknown): value is { code: string } {
  return (
    typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
  );
}

function invalidSql(message: string): BatchLabSourceQueryError {
  return new BatchLabSourceQueryError('BATCH_LAB_INVALID_SQL', message);
}
