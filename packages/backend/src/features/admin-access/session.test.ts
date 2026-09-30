import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  tokenUser: { id: '00000000-0000-4000-8000-0000000000a1' } as { id: string } | null,
  userError: null as { message: string } | null,
  adminUser: {
    role: 'owner',
    can_access_test: true,
    can_access_prod: false,
  } as { role: string; can_access_test: boolean; can_access_prod: boolean } | null,
  adminError: null as { message: string } | null,
  target: 'test' as 'test' | 'production',
};

vi.mock('../../platform/config.js', () => ({
  get config() {
    return { database: { target: state.target } };
  },
}));

vi.mock('../../lib/supabase.js', () => ({
  getSupabaseClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.tokenUser }, error: state.userError }),
    },
    schema: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state.adminUser, error: state.adminError }),
          }),
        }),
      }),
    }),
  }),
}));

import { requireAdminActor } from './session.js';

describe('requireAdminActor', () => {
  beforeEach(() => {
    state.tokenUser = { id: '00000000-0000-4000-8000-0000000000a1' };
    state.userError = null;
    state.adminUser = { role: 'owner', can_access_test: true, can_access_prod: false };
    state.adminError = null;
    state.target = 'test';
  });

  it('rejects a missing or invalid session', async () => {
    await expect(requireAdminActor(undefined, 'read')).rejects.toMatchObject({ statusCode: 401 });
    state.tokenUser = null;
    state.userError = { message: 'bad' };
    await expect(requireAdminActor('Bearer token', 'write')).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('lets a viewer read the current environment and rejects viewer writes', async () => {
    state.adminUser = { role: 'viewer', can_access_test: true, can_access_prod: false };
    await expect(requireAdminActor('Bearer token', 'read')).resolves.toMatchObject({
      role: 'viewer',
    });
    await expect(requireAdminActor('Bearer token', 'write')).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('lets owner and operator write, and isolates the other environment', async () => {
    state.adminUser = { role: 'operator', can_access_test: true, can_access_prod: false };
    await expect(requireAdminActor('Bearer token', 'write')).resolves.toMatchObject({
      role: 'operator',
    });
    state.target = 'production';
    await expect(requireAdminActor('Bearer token', 'read')).rejects.toMatchObject({
      statusCode: 403,
    });
    state.adminUser = { role: 'owner', can_access_test: false, can_access_prod: true };
    await expect(requireAdminActor('Bearer token', 'write')).resolves.toMatchObject({
      role: 'owner',
    });
  });
});
