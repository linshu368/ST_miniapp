import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentContext, newContext, withContext } from '../../platform/observability/context.js';

const db = vi.hoisted(() => ({
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock('../../lib/supabase.js', () => ({ getDomainDb: () => db }));
import { ChatSessionRepository } from './ChatSessionRepository.js';

const userId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const characterId = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.resetAllMocks();
  for (const method of [db.from, db.select, db.eq, db.is]) method.mockReturnValue(db);
});

describe('verified session log correlation', () => {
  it('binds an existing owned session and character without another query', async () => {
    const session = { id: sessionId, user_id: userId, character_id: characterId };
    db.maybeSingle.mockResolvedValue({ data: session, error: null });
    await withContext(newContext(), async () => {
      expect(await new ChatSessionRepository().requireSession(sessionId, userId)).toBe(session);
      expect(currentContext()?.business).toEqual({
        session_id: sessionId,
        character_id: characterId,
      });
    });
    expect(db.eq.mock.calls).toEqual([
      ['id', sessionId],
      ['user_id', userId],
    ]);
    expect(db.is).toHaveBeenCalledWith('deleted_at', null);
    expect(db.maybeSingle).toHaveBeenCalledOnce();
  });

  it.each([null, { message: 'private-db-details' }])(
    'does not invent a character on missing/failed reads: %j',
    async (error) => {
      db.maybeSingle.mockResolvedValue({ data: null, error });
      await withContext(newContext(), async () => {
        await expect(
          new ChatSessionRepository().requireSession(sessionId, userId)
        ).rejects.toThrow();
        expect(currentContext()?.business).toEqual({});
      });
    }
  );
});
