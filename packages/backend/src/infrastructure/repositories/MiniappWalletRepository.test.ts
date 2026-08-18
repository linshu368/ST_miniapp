import { describe, expect, it } from 'vitest';

import { formatSpendingStatus } from './MiniappWalletRepository.js';

describe('formatSpendingStatus', () => {
  it('shows the three settlement paths directly', () => {
    expect(formatSpendingStatus('pending', { reply_outcome: 'incomplete' })).toBe('待结算');
    expect(formatSpendingStatus('charged', { reply_outcome: 'complete' })).toBe('已扣费');
    expect(formatSpendingStatus('failed', { reply_outcome: 'incomplete' })).toBe('截断未扣除');
    expect(formatSpendingStatus('failed', { reply_outcome: 'empty' })).toBe('生成失败，未扣除');
  });

  it('maps legacy technical metadata to experience-based labels', () => {
    expect(formatSpendingStatus('failed', { finish_reason: 'content_filter' })).toBe('截断未扣除');
    expect(formatSpendingStatus('failed', { chat_status: 'upstream_error' })).toBe(
      '生成失败，未扣除'
    );
  });
});
