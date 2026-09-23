/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-11 16:33:34
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-11 17:33:27
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
import { describe, expect, it } from 'vitest';
import { assertSourceProbe, BatchLabSourceProbeError } from './source-database.js';

describe('Batch Lab source database probe', () => {
  it('accepts only the dedicated read-only role with bounded timeouts', () => {
    expect(() =>
      assertSourceProbe({
        current_user: 'batch_lab_source_login',
        transaction_read_only: 'on',
        statement_timeout: '5s',
        lock_timeout: '500ms',
      })
    ).not.toThrow();
  });

  it.each([
    [undefined, 'probe: missing-row'],
    [
      {
        current_user: 'postgres',
        transaction_read_only: 'on',
        statement_timeout: '5s',
        lock_timeout: '500ms',
      },
      'probe: identity-mismatch',
    ],
    [
      {
        current_user: 'batch_lab_source_login',
        transaction_read_only: 'off',
        statement_timeout: '5s',
        lock_timeout: '500ms',
      },
      'probe: read-only-mismatch',
    ],
    [
      {
        current_user: 'batch_lab_source_login',
        transaction_read_only: 'on',
        statement_timeout: '6s',
        lock_timeout: '500ms',
      },
      'probe: statement-timeout-mismatch',
    ],
    [
      {
        current_user: 'batch_lab_source_login',
        transaction_read_only: 'on',
        statement_timeout: '5s',
        lock_timeout: '1s',
      },
      'probe: lock-timeout-mismatch',
    ],
  ] as const)('classifies an unsafe source session as %s', (row, diagnostic) => {
    try {
      assertSourceProbe(row);
      throw new Error('expected probe rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(BatchLabSourceProbeError);
      expect((err as BatchLabSourceProbeError).diagnostic).toBe(diagnostic);
    }
  });
});
