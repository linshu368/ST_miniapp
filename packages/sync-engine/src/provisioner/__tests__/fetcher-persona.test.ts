import { describe, expect, it, vi } from 'vitest';

const DEFAULT_AVATAR_URL = 'https://prod.example/default-avatar.png';

vi.mock('../../lib/config.js', () => ({
  config: {
    DEFAULT_USER_AVATAR_URL: 'https://prod.example/default-avatar.png',
  },
}));

import { resolveUserPersona } from '../fetcher.js';

const baseRow = {
  display_name: null,
  tg_first_name: null,
  tg_last_name: null,
  tg_username: null,
  tg_avatar_url: null,
  custom_avatar_url: null,
  selected_model_id: null,
};

describe('resolveUserPersona avatar resolution', () => {
  it('resolves custom > Telegram > configured default avatar', () => {
    expect(
      resolveUserPersona({
        ...baseRow,
        custom_avatar_url: ' https://cdn.example/custom.png ',
        tg_avatar_url: 'https://telegram.example/avatar.png',
      }).avatarUrl
    ).toBe('https://cdn.example/custom.png');

    expect(
      resolveUserPersona({
        ...baseRow,
        tg_avatar_url: ' https://telegram.example/avatar.png ',
      }).avatarUrl
    ).toBe('https://telegram.example/avatar.png');

    expect(resolveUserPersona(baseRow).avatarUrl).toBe(DEFAULT_AVATAR_URL);
    expect(resolveUserPersona(null).avatarUrl).toBe(DEFAULT_AVATAR_URL);
  });
});
