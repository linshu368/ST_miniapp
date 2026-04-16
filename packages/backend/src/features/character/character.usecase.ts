import { supabase } from '../../infrastructure/supabase/client';
import { ok } from '@miniapp/shared';
import type { GetCharactersData, GetCharacterByIdData, ApiSuccessResponse } from '@miniapp/shared';

export async function getCharacters(): Promise<ApiSuccessResponse<GetCharactersData>> {
  const { data, error } = await supabase
    .from('role_data')
    .select('id, role_id, name, description, avatar, tags')
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch characters: ${error.message}`);
  }

  return ok({ characters: data || [] });
}

export async function getCharacterById(
  roleId: string
): Promise<ApiSuccessResponse<GetCharacterByIdData> | null> {
  const { data, error } = await supabase
    .from('role_data')
    .select('id, role_id, name, description, avatar, tags, first_mes, creator_notes')
    .eq('role_id', roleId)  // 使用 role_id 而非 id
    .single();

  if (error || !data) {
    return null;
  }

  return ok({ character: data });
}