import { describe, expect, it } from 'vitest';
import { hasNewLobbyCharacters } from './lobby-latest-badge.js';

const YESTERDAY = '2026-08-01T10:00:00.000Z';
const TODAY = '2026-08-02T10:00:00.000Z';

describe('lobby latest badge', () => {
  it('lights up when a card was listed after the user last opened 最新', () => {
    expect(hasNewLobbyCharacters(TODAY, YESTERDAY)).toBe(true);
  });

  it('stays hidden once the user has opened 最新 after the latest listing', () => {
    expect(hasNewLobbyCharacters(YESTERDAY, TODAY)).toBe(false);
  });

  it('treats a user who never opened 最新 as having new cards', () => {
    expect(hasNewLobbyCharacters(TODAY, null)).toBe(true);
    expect(hasNewLobbyCharacters(TODAY, undefined)).toBe(true);
  });

  it('shows nothing when no card is listed at all', () => {
    expect(hasNewLobbyCharacters(null, null)).toBe(false);
    expect(hasNewLobbyCharacters(undefined, YESTERDAY)).toBe(false);
  });

  it('does not re-light on an equal timestamp, so one tap settles the round', () => {
    expect(hasNewLobbyCharacters(TODAY, TODAY)).toBe(false);
  });

  it('accepts Date objects, because Prisma returns them for timestamptz', () => {
    expect(hasNewLobbyCharacters(new Date(TODAY), new Date(YESTERDAY))).toBe(true);
    expect(hasNewLobbyCharacters(new Date(YESTERDAY), new Date(TODAY))).toBe(false);
  });

  it('falls back to showing the badge when the watermark is unparsable', () => {
    expect(hasNewLobbyCharacters(TODAY, 'not-a-date')).toBe(true);
  });

  it('stays hidden when the listing timestamp is unparsable', () => {
    expect(hasNewLobbyCharacters('not-a-date', YESTERDAY)).toBe(false);
  });
});
