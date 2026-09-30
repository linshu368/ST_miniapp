import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const snapshots = {
  readSnapshot: vi.fn(),
  markEntryViewed: vi.fn(),
};

vi.mock('../platform/vip-strategy.js', () => ({
  readVipStrategy: vi.fn(async () => ({ discountRate: 0.95, checkin: { mode: 'same_as_base' } })),
}));
vi.mock('../platform/runtime-config.js', () => ({
  fetchRuntimeConfigEntryStrict: vi.fn(async () => ({ value: 60, textValue: null, version: 1 })),
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabaseClient: () => ({ schema: () => ({}) }),
  getDomainDb: () => ({}),
}));

vi.mock('../lib/user.js', () => ({
  getOrCreateDbUser: vi.fn(async () => ({
    id: '00000000-0000-4000-8000-000000000099',
  })),
}));

vi.mock('../infrastructure/repositories/MiniappVipRepository.js', () => ({
  MiniappVipRepository: class {
    constructor() {
      return snapshots;
    }
  },
}));

async function buildApp() {
  const { default: vipRoutes } = await import('./vip.js');
  const app = Fastify({ logger: false });
  await app.register(vipRoutes);
  await app.ready();
  return app;
}

describe('VIP status routes', () => {
  beforeEach(() => {
    snapshots.readSnapshot.mockReset();
    snapshots.markEntryViewed.mockReset();
    snapshots.readSnapshot.mockResolvedValue({
      valid_from: '2026-09-01T00:00:00.000Z',
      valid_until: '2026-10-01T00:00:00.000Z',
      last_plan_id: 'week',
      entry_seen_at: null,
    });
    snapshots.markEntryViewed.mockResolvedValue(undefined);
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
  });

  it('reads status for the authenticated user and ignores a client user id', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vip/status?user_id=00000000-0000-4000-8000-000000000002',
      });
      expect(response.statusCode).toBe(200);
      expect(snapshots.readSnapshot).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000099');
      const body = response.json() as { success: boolean; data: { active: boolean } };
      expect(body.success).toBe(true);
      expect(body.data.active).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('returns an inactive status when the repository fails', async () => {
    snapshots.readSnapshot.mockRejectedValueOnce(new Error('db down'));
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/vip/status' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        success: true,
        data: { active: false, entry_badge_visible: false, remaining_days: 0 },
      });
    } finally {
      await app.close();
    }
  });

  it('keeps published benefits for a non-member before and after entry-viewed', async () => {
    snapshots.readSnapshot.mockResolvedValue({
      valid_from: null,
      valid_until: null,
      last_plan_id: null,
      entry_seen_at: null,
    });
    const app = await buildApp();
    try {
      const expected = {
        text_discount_rate: 0.95,
        checkin_base_credits: 60,
        checkin_vip_credits: 60,
      };
      const before = await app.inject({ method: 'GET', url: '/api/vip/status' });
      expect(before.json()).toMatchObject({
        data: { active: false, entry_badge_visible: true, benefits: expected },
      });
      snapshots.readSnapshot.mockResolvedValue({
        valid_from: null,
        valid_until: null,
        last_plan_id: null,
        entry_seen_at: '2026-09-23T00:00:00Z',
      });
      const after = await app.inject({ method: 'POST', url: '/api/vip/entry-viewed' });
      expect(after.json()).toMatchObject({
        data: { active: false, entry_badge_visible: false, benefits: expected },
      });
    } finally {
      await app.close();
    }
  });

  it('marks only the authenticated user and does not claim success when the write fails', async () => {
    const app = await buildApp();
    try {
      const ok = await app.inject({ method: 'POST', url: '/api/vip/entry-viewed' });
      expect(ok.statusCode).toBe(200);
      expect(snapshots.markEntryViewed).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000099',
        expect.any(String)
      );

      snapshots.markEntryViewed.mockRejectedValueOnce(new Error('db down'));
      const failed = await app.inject({
        method: 'POST',
        url: '/api/vip/entry-viewed',
        payload: { user_id: '00000000-0000-4000-8000-000000000002' },
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toMatchObject({ success: false });
    } finally {
      await app.close();
    }
  });
});
