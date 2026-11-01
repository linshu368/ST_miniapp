import { getDomainDb } from '../../lib/supabase.js';
import type { CreatorRewardSnapshot } from '../../infrastructure/repositories/ConversationHistoryRepository.js';

/** Author identity is independent of publication/review state. Missing schema is an error. */
export async function getCharacterCreatorOwner(characterId: string | null): Promise<string | null> {
  if (!characterId) return null;
  const { data, error } = await getDomainDb('app_core')
    .from('character_creations')
    .select('owner_user_id')
    .eq('character_id', characterId)
    .abortSignal(AbortSignal.timeout(5_000))
    .maybeSingle();
  if (error) throw new Error('Unable to resolve character creator', { cause: error });
  if (!data) return null;
  if (typeof data.owner_user_id !== 'string') throw new Error('Invalid character creator identity');
  return data.owner_user_id;
}

export function creatorRewardSnapshot(
  characterId: string | null,
  creatorUserId: string | null
): CreatorRewardSnapshot | undefined {
  if (!characterId || !creatorUserId) return undefined;
  return {
    character_id: characterId,
    creator_user_id: creatorUserId,
    rate: 0.4,
    wallet: 'bonus',
    policy_version: 1,
  };
}

/** Invalid persisted money facts must not silently turn a creator round into an official one. */
export function readCreatorRewardSnapshot(value: unknown): CreatorRewardSnapshot | undefined {
  if (value === undefined) return undefined;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      typeof row.character_id === 'string' &&
      uuid.test(row.character_id) &&
      typeof row.creator_user_id === 'string' &&
      uuid.test(row.creator_user_id) &&
      row.rate === 0.4 &&
      row.wallet === 'bonus' &&
      row.policy_version === 1
    ) {
      return creatorRewardSnapshot(row.character_id, row.creator_user_id);
    }
  }
  throw new Error('Invalid frozen creator reward snapshot');
}
