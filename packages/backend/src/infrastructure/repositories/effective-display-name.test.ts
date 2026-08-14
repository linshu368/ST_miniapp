import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_DISPLAY_NAME } from '@miniapp/shared';

import { resolveEffectiveDisplayName } from './effective-display-name.js';

describe('resolveEffectiveDisplayName', () => {
  it('prefers custom display_name', () => {
    expect(
      resolveEffectiveDisplayName({
        display_name: '  路人甲  ',
        tg_first_name: 'Telegram',
        tg_username: 'tg_user',
      })
    ).toBe('路人甲');
  });

  it('falls back to Telegram first name, then username, then the default', () => {
    expect(
      resolveEffectiveDisplayName({
        display_name: null,
        tg_first_name: ' Alice ',
        tg_username: 'alice',
      })
    ).toBe('Alice');
    expect(
      resolveEffectiveDisplayName({
        display_name: '  ',
        tg_first_name: null,
        tg_username: 'alice',
      })
    ).toBe('alice');
    expect(
      resolveEffectiveDisplayName({
        display_name: null,
        tg_first_name: null,
        tg_username: null,
      })
    ).toBe(DEFAULT_USER_DISPLAY_NAME);
    expect(resolveEffectiveDisplayName(null)).toBe(DEFAULT_USER_DISPLAY_NAME);
  });
});
