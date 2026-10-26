import { describe, expect, it } from 'vitest';

import { resolveRequestPriority } from './client';

describe('resolveRequestPriority', () => {
  it('marks lobby character detail and conversation detail as critical', () => {
    expect(resolveRequestPriority('/api/characters/abc', 'GET')).toBe('critical');
    expect(resolveRequestPriority('/api/v1/conversations/sess-1', 'GET')).toBe('critical');
    expect(resolveRequestPriority('/api/v1/conversations', 'POST')).toBe('critical');
    expect(resolveRequestPriority('/api/image-plaza/feed?sort=recommended', 'GET')).toBe(
      'critical'
    );
  });

  it('does not treat latest-badge as character detail', () => {
    expect(resolveRequestPriority('/api/characters/latest-badge', 'GET')).toBe('normal');
  });

  it('honors explicit priority and bypasses long-running paths', () => {
    expect(resolveRequestPriority('/api/favorites/ids', 'GET', 'background')).toBe('background');
    expect(resolveRequestPriority('/api/v1/conversations/s1/messages/m1/voice', 'POST')).toBe(
      'bypass'
    );
  });
});
