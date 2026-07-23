import { DEFAULT_USER_AVATAR_URL } from '@miniapp/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const telegramPhotoUrl = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('@/lib/telegram/user', () => ({
  getTelegramDefaultDisplayName: () => '你',
  getTelegramPhotoUrl: () => telegramPhotoUrl.value,
}));

import { useUserProfileStore } from './user-profile-store';

describe('useUserProfileStore avatar fallback', () => {
  beforeEach(() => {
    telegramPhotoUrl.value = undefined;
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
    useUserProfileStore.setState({ photoUrl: DEFAULT_USER_AVATAR_URL });
  });

  it('uses the shared default immediately when Telegram has no photo', () => {
    useUserProfileStore.getState().hydrate();

    expect(useUserProfileStore.getState().photoUrl).toBe(DEFAULT_USER_AVATAR_URL);
  });

  it('falls back to the shared default for an empty server photo URL', () => {
    telegramPhotoUrl.value = 'https://telegram.example/avatar.png';

    useUserProfileStore.getState().applyServerPhotoUrl('  ');

    expect(useUserProfileStore.getState().photoUrl).toBe(DEFAULT_USER_AVATAR_URL);
  });
});
