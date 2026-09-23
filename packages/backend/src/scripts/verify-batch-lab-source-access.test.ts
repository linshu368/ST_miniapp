/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-11 17:08:11
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-11 17:33:34
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { BatchLabSourceProbeError } from '../features/batch-lab/source-database.js';
import {
  classifySafeDiagnostic,
  isExpectedDenial,
  runDeniedCheck,
} from './verify-batch-lab-source-access.js';

function poolWithResult(result: 'allowed' | string): Pool {
  const query =
    result === 'allowed'
      ? vi.fn().mockResolvedValue({ rows: [] })
      : vi.fn().mockRejectedValue(Object.assign(new Error('redacted'), { code: result }));
  return { query } as unknown as Pool;
}

describe('Batch Lab source access verifier', () => {
  it.each(['25006', '42501'])('accepts expected database denial %s', (code) => {
    expect(isExpectedDenial({ code })).toBe(true);
  });

  it.each(['28P01', '08006', '57014', '42883', undefined])(
    'rejects an unrelated failure instead of reporting a false pass: %s',
    (code) => {
      expect(isExpectedDenial(code ? { code } : new Error('unknown'))).toBe(false);
    }
  );

  it('fails when a forbidden statement succeeds', async () => {
    await expect(
      runDeniedCheck(poolWithResult('allowed'), { name: 'forbidden write', sql: 'probe' })
    ).rejects.toThrow('Unsafe source permission');
  });

  it('fails closed when a denial probe has an unexpected database error', async () => {
    await expect(
      runDeniedCheck(poolWithResult('08006'), { name: 'forbidden write', sql: 'probe' })
    ).rejects.toThrow('Unexpected source verification failure');
  });

  it.each([
    [{ code: 'ENOTFOUND' }, 'connect: dns'],
    [{ code: 'EAI_AGAIN' }, 'connect: dns'],
    [{ code: '28P01' }, 'connect: authentication'],
    [{ code: '28000' }, 'connect: authorization'],
    [{ code: 'ETIMEDOUT' }, 'connect: timeout'],
    [{ code: 'ECONNRESET' }, 'connect: network'],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'connect: tls'],
    [{ code: '53300' }, 'connect: capacity'],
    [{ code: '57P03' }, 'connect: unavailable'],
    [{ code: '42P01' }, 'database: rejected'],
    [new Error('must not be printed'), 'connect-or-probe: unknown'],
  ])('classifies errors without returning raw details: %s', (err, expected) => {
    expect(classifySafeDiagnostic(err)).toBe(expected);
  });

  it.each([
    'probe: missing-row',
    'probe: identity-mismatch',
    'probe: read-only-mismatch',
    'probe: statement-timeout-mismatch',
    'probe: lock-timeout-mismatch',
  ] as const)('reports the safe probe category %s', (diagnostic) => {
    expect(classifySafeDiagnostic(new BatchLabSourceProbeError(diagnostic))).toBe(diagnostic);
  });
});
