import { describe, expect, it } from 'vitest';
import type { CommunityEntryData, VerifyCommunityMembershipData } from '../api/community.js';

describe('official community contracts', () => {
  it('represents an excluded preexisting member without exposing database rows', () => {
    const entry: CommunityEntryData = {
      enabled: true,
      title: '加入官方社群',
      description: '加入秘境官方社群，与大家一起交流。',
      reward_credits: 500,
      telegram_url: 'https://t.me/MijingAI_Official',
      fallback_handle: '@MijingAI_Official',
      claim_status: 'ineligible',
      rewarded_at: null,
    };
    expect(entry.claim_status).toBe('ineligible');
  });

  it.each([
    'rewarded',
    'already_rewarded',
    'not_member',
    'pending',
    'ineligible',
    'disabled',
  ] as const)('supports verify status %s', (status) => {
    const result: VerifyCommunityMembershipData = {
      status,
      reward_credits: 500,
      rewarded_at: status === 'rewarded' ? '2026-09-03T00:00:00.000Z' : null,
    };
    expect(result.status).toBe(status);
  });
});
