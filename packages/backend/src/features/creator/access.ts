import type { Prisma } from '@prisma/client';
import { getDomainDb } from '../../lib/supabase.js';

/** Same predicate as SQL can_discover_character; pending edits retain the approved runtime. */
export const discoverableCharacterWhere: Prisma.CharacterWhereInput = {
  enabled: true,
  archived_at: null,
  OR: [
    { creation: { is: null } },
    {
      creation: { is: { state: 'ready', visibility: 'public', approved_revision: { not: null } } },
    },
  ],
};

export async function canUseCharacter(
  userId: string | null,
  characterId: string
): Promise<boolean> {
  const { data, error } = await getDomainDb('app_core')
    .rpc('can_use_character', { p_user_id: userId, p_character_id: characterId })
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw error;
  return data === true;
}

export async function grantCreatorCharacterAccess(
  userId: string,
  characterId: string
): Promise<void> {
  const { error } = await getDomainDb('app_core')
    .rpc('grant_creator_character_access', { p_user_id: userId, p_character_id: characterId })
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw error;
}

export async function requireCreatorCharacterAccess(
  userId: string,
  characterId: string
): Promise<void> {
  const { data: creation, error } = await getDomainDb('app_core')
    .from('character_creations')
    .select('character_id')
    .eq('character_id', characterId)
    .abortSignal(AbortSignal.timeout(5_000))
    .maybeSingle();
  if (error) throw error;
  // Official cards deliberately retain their old-session behavior after operator unlisting.
  if (creation && !(await canUseCharacter(userId, characterId))) {
    throw Object.assign(new Error('角色已不可用'), { code: 'P0404' });
  }
}
