import { describe, expect, it } from 'vitest';

import { normalizeTelegramAvatarUrl } from '../telegram-avatar.js';

describe('normalizeTelegramAvatarUrl', () => {
  it('treats Telegram generated SVG userpics as missing', () => {
    expect(
      normalizeTelegramAvatarUrl(
        'https://t.me/i/userpic/320/vaWa7P-yk8TJ40-AQ-R_qOg5_dfd4p8j3BVI9E_omcjvcbuLDLmY-dymor6jp7W_.svg'
      )
    ).toBeNull();
  });

  it('preserves real Telegram photos and custom legacy URLs', () => {
    expect(normalizeTelegramAvatarUrl(' https://t.me/i/userpic/320/avatar.jpg ')).toBe(
      'https://t.me/i/userpic/320/avatar.jpg'
    );
    expect(normalizeTelegramAvatarUrl('https://example.com/avatar.svg')).toBe(
      'https://example.com/avatar.svg'
    );
  });

  it('normalizes empty values to null', () => {
    expect(normalizeTelegramAvatarUrl(undefined)).toBeNull();
    expect(normalizeTelegramAvatarUrl('  ')).toBeNull();
  });
});
