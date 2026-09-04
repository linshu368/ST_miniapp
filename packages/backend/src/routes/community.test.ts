/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-04 09:17:52
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-04 10:20:03
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveCommunityWebhookSecret,
  isEligibleJoinTransition,
  isUniqueViolation,
  isValidTelegramUpdateIdentity,
  resolveCommunityClaimStatus,
  secretMatches,
} from './community.js';

const base = {
  enabled: true,
  configuredChatId: '-100123',
  startedAt: '2026-09-03T00:00:00.000Z',
  eventChatId: '-100123',
  occurredAt: new Date('2026-09-03T00:00:01.000Z'),
  oldStatus: 'left',
  newStatus: 'member',
};

describe('community webhook guards', () => {
  it('distinguishes existing members from users waiting for automatic rewards', () => {
    expect(resolveCommunityClaimStatus(true, true)).toBe('rewarded');
    expect(resolveCommunityClaimStatus(false, true)).toBe('existing_member');
    expect(resolveCommunityClaimStatus(false, false)).toBe('unclaimed');
  });

  it('requires an exact non-empty webhook secret', () => {
    expect(secretMatches('secret', 'secret')).toBe(true);
    expect(secretMatches('secret-x', 'secret')).toBe(false);
    expect(secretMatches(undefined, 'secret')).toBe(false);
    expect(secretMatches('', '')).toBe(false);
  });

  it('treats only PostgreSQL unique violations as duplicate receipt claims', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: '42P01' })).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
  });

  it('rejects malformed Telegram update identities before persistence', () => {
    expect(isValidTelegramUpdateIdentity(1, 2, -100123)).toBe(true);
    expect(isValidTelegramUpdateIdentity(undefined, 2, -100123)).toBe(false);
    expect(isValidTelegramUpdateIdentity(1, Number.NaN, -100123)).toBe(false);
    expect(isValidTelegramUpdateIdentity(1, 0, -100123)).toBe(false);
    expect(isValidTelegramUpdateIdentity(1, 2, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidTelegramUpdateIdentity(1, 2, 0)).toBe(false);
  });

  it('derives a Telegram-compatible webhook secret from the only Community Bot setting', () => {
    const derived = deriveCommunityWebhookSecret('123456:bot-token');
    expect(derived).toMatch(/^[a-f0-9]{64}$/);
    expect(derived).toBe(deriveCommunityWebhookSecret('123456:bot-token'));
    expect(deriveCommunityWebhookSecret('')).toBe('');
  });

  it('accepts only a new active membership in the configured chat after campaign start', () => {
    expect(isEligibleJoinTransition(base)).toBe(true);
    expect(isEligibleJoinTransition({ ...base, enabled: false })).toBe(false);
    expect(isEligibleJoinTransition({ ...base, eventChatId: '-100999' })).toBe(false);
    expect(
      isEligibleJoinTransition({ ...base, occurredAt: new Date('2026-09-02T23:59:59.000Z') })
    ).toBe(false);
    expect(isEligibleJoinTransition({ ...base, oldStatus: 'member' })).toBe(false);
    expect(isEligibleJoinTransition({ ...base, newStatus: 'left' })).toBe(false);
  });

  it.each(['member', 'administrator', 'creator'])('accepts active status %s', (newStatus) => {
    expect(isEligibleJoinTransition({ ...base, newStatus })).toBe(true);
  });
});
