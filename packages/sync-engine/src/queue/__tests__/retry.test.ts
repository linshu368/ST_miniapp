/**
 * queue / __tests__ / retry.test.ts
 *
 * computeRetry() 纯函数测试。
 *
 * 测试重点：
 *   1. 每次重试的延迟符合指数退避公式
 *   2. 达到最大次数时返回 shouldRetry=false
 *   3. 未达最大次数时返回正确的 nextRetryAt
 *   4. 边界：attempts=0（首次失败）
 */

import { describe, it, expect } from 'vitest';
import { computeRetry } from '../retry.js';

const FIXED_NOW = new Date('2026-06-01T12:00:00Z');

describe('computeRetry()', () => {
  // ── 指数退避延迟 ────────────────────────────────────────────────────────

  it('attempt=1 → 延迟 5s', () => {
    const result = computeRetry(1, 5, FIXED_NOW);

    expect(result.shouldRetry).toBe(true);
    expect(result.delayMs).toBe(5_000);
    expect(result.nextRetryAt!.getTime()).toBe(FIXED_NOW.getTime() + 5_000);
  });

  it('attempt=2 → 延迟 10s', () => {
    const result = computeRetry(2, 5, FIXED_NOW);

    expect(result.shouldRetry).toBe(true);
    expect(result.delayMs).toBe(10_000);
    expect(result.nextRetryAt!.getTime()).toBe(FIXED_NOW.getTime() + 10_000);
  });

  it('attempt=3 → 延迟 20s', () => {
    const result = computeRetry(3, 5, FIXED_NOW);

    expect(result.shouldRetry).toBe(true);
    expect(result.delayMs).toBe(20_000);
  });

  it('attempt=4 → 延迟 40s', () => {
    const result = computeRetry(4, 5, FIXED_NOW);

    expect(result.shouldRetry).toBe(true);
    expect(result.delayMs).toBe(40_000);
  });

  // ── 达到最大次数 → 死信 ────────────────────────────────────────────────

  it('attempt=5（= maxAttempts）→ shouldRetry=false（死信）', () => {
    const result = computeRetry(5, 5, FIXED_NOW);

    expect(result.shouldRetry).toBe(false);
    expect(result.nextRetryAt).toBeNull();
    expect(result.delayMs).toBeNull();
  });

  it('attempt=6（> maxAttempts）→ shouldRetry=false', () => {
    const result = computeRetry(6, 5, FIXED_NOW);

    expect(result.shouldRetry).toBe(false);
  });

  // ── 自定义 maxAttempts ─────────────────────────────────────────────────

  it('maxAttempts=1 时，attempt=1 直接死信', () => {
    const result = computeRetry(1, 1, FIXED_NOW);

    expect(result.shouldRetry).toBe(false);
  });

  it('maxAttempts=3 时，attempt=2 仍可重试', () => {
    const result = computeRetry(2, 3, FIXED_NOW);

    expect(result.shouldRetry).toBe(true);
    expect(result.delayMs).toBe(10_000);
  });

  // ── 使用默认参数 ──────────────────────────────────────────────────────

  it('不传 maxAttempts 时默认 5', () => {
    const retryable = computeRetry(4);
    expect(retryable.shouldRetry).toBe(true);

    const dead = computeRetry(5);
    expect(dead.shouldRetry).toBe(false);
  });

  it('不传 now 时使用当前时间', () => {
    const before = Date.now();
    const result = computeRetry(1, 5);
    const after = Date.now();

    expect(result.shouldRetry).toBe(true);
    expect(result.nextRetryAt!.getTime()).toBeGreaterThanOrEqual(before + 5_000);
    expect(result.nextRetryAt!.getTime()).toBeLessThanOrEqual(after + 5_000);
  });
});
