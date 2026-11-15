import { describe, expect, it } from 'vitest';
import { RecordGrowthPromptEventRequestSchema } from '../api/growth-prompts';

describe('growth prompt contracts', () => {
  it('accepts known kinds and events only', () => {
    expect(
      RecordGrowthPromptEventRequestSchema.safeParse({ kind: 'vip', event: 'shown' }).success
    ).toBe(true);
    expect(
      RecordGrowthPromptEventRequestSchema.safeParse({ kind: 'invite', event: 'shown' }).success
    ).toBe(false);
    expect(
      RecordGrowthPromptEventRequestSchema.safeParse({ kind: 'community', event: 'clicked' })
        .success
    ).toBe(false);
    expect(
      RecordGrowthPromptEventRequestSchema.safeParse({
        kind: 'community',
        event: 'accepted',
        extra: 1,
      }).success
    ).toBe(false);
  });
});
