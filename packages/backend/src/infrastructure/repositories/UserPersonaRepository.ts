// 主角人设库与"按角色卡的补充设定 / 人设选择"。存储见 migration 20261118_character_persona.sql。
// 人设库只经数据库函数写（上限、默认唯一在事务里保证）；按卡偏好由后端直接 upsert，
// 复合外键保证只能选自己的人设，删除人设后自动回到"跟随默认"。

import type { CharacterPersonaChoice, SavePersonaRequest, UserPersona } from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';

const TIMEOUT_MS = 5_000;
const PERSONA_COLUMNS = 'id, name, description, is_default';

/** 业务可预期的失败，路由据此映射 HTTP 状态；其余错误一律按 500 处理。 */
export class PersonaRepositoryError extends Error {
  constructor(
    readonly code: 'PERSONA_LIMIT' | 'PERSONA_NOT_FOUND' | 'CHARACTER_NOT_FOUND',
    options?: ErrorOptions
  ) {
    super(code, options);
  }
}

/** 注入 prompt 的两段设定；空串表示这一段不出现。 */
export interface CharacterPromptSettingsRow {
  notes: string;
  personaDescription: string;
}

export interface CharacterMySettingsRow {
  notes: string;
  persona: CharacterPersonaChoice;
}

interface PersonaDbRow {
  id: string;
  name: string;
  description: string;
  is_default: boolean;
}

interface PreferenceDbRow {
  character_notes: string;
  persona_id: string | null;
  persona_disabled: boolean;
}

function toPersona(row: PersonaDbRow): UserPersona {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    is_default: row.is_default,
  };
}

function toChoice(row: PreferenceDbRow | null): CharacterPersonaChoice {
  if (row?.persona_disabled) return { mode: 'none', persona_id: null };
  if (row?.persona_id) return { mode: 'persona', persona_id: row.persona_id };
  return { mode: 'default', persona_id: null };
}

export class UserPersonaRepository {
  private get db() {
    return getDomainDb('app_core');
  }

  async listPersonas(userId: string): Promise<UserPersona[]> {
    const { data, error } = await this.db
      .from('user_personas')
      .select(PERSONA_COLUMNS)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw new Error(`查询主角人设失败：${error.message}`, { cause: error });
    return ((data ?? []) as PersonaDbRow[]).map(toPersona);
  }

  /** personaId 为空 = 新建。 */
  async savePersona(
    userId: string,
    personaId: string | null,
    input: SavePersonaRequest
  ): Promise<UserPersona> {
    const { data, error } = await this.db
      .rpc('save_user_persona', {
        p_user_id: userId,
        p_persona_id: personaId,
        p_name: input.name,
        p_description: input.description,
        p_is_default: input.is_default,
      })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) {
      if (error.message.includes('persona_limit'))
        throw new PersonaRepositoryError('PERSONA_LIMIT', { cause: error });
      if (error.message.includes('persona_not_found'))
        throw new PersonaRepositoryError('PERSONA_NOT_FOUND', { cause: error });
      throw new Error(`保存主角人设失败：${error.message}`, { cause: error });
    }
    return toPersona(data as PersonaDbRow);
  }

  async deletePersona(userId: string, personaId: string): Promise<boolean> {
    const { data, error } = await this.db
      .rpc('delete_user_persona', { p_user_id: userId, p_persona_id: personaId })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw new Error(`删除主角人设失败：${error.message}`, { cause: error });
    return data === true;
  }

  async readMySettings(userId: string, characterId: string): Promise<CharacterMySettingsRow> {
    const { data, error } = await this.db
      .from('user_character_preferences')
      .select('character_notes, persona_id, persona_disabled')
      .eq('user_id', userId)
      .eq('character_id', characterId)
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS))
      .maybeSingle();
    if (error) throw new Error(`查询角色设定失败：${error.message}`, { cause: error });
    const row = (data ?? null) as PreferenceDbRow | null;
    return { notes: row?.character_notes ?? '', persona: toChoice(row) };
  }

  /**
   * 只写传入的部分：upsert 冲突时 PostgREST 只更新请求里带的列，
   * 所以改补充设定不会动人设选择，反之亦然。
   */
  async writeMySettings(
    userId: string,
    characterId: string,
    patch: { notes?: string; persona?: CharacterPersonaChoice }
  ): Promise<void> {
    const row: Record<string, unknown> = {
      user_id: userId,
      character_id: characterId,
      updated_at: new Date().toISOString(),
    };
    if (patch.notes !== undefined) row.character_notes = patch.notes;
    if (patch.persona !== undefined) {
      row.persona_id = patch.persona.persona_id;
      row.persona_disabled = patch.persona.mode === 'none';
    }
    const { error } = await this.db
      .from('user_character_preferences')
      .upsert(row, { onConflict: 'user_id,character_id' })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) {
      // 23503：外键不成立。复合外键保证人设属于本人，所以这里只会是人设或角色卡不存在。
      if (error.code === '23503') {
        throw new PersonaRepositoryError(
          error.message.includes('persona') ? 'PERSONA_NOT_FOUND' : 'CHARACTER_NOT_FOUND',
          { cause: error }
        );
      }
      throw new Error(`保存角色设定失败：${error.message}`, { cause: error });
    }
  }

  /** 生成链路读取：一次返回补充设定与生效人设描述，没填的段是空串。 */
  async readPromptSettings(
    userId: string,
    characterId: string
  ): Promise<CharacterPromptSettingsRow> {
    const { data, error } = await this.db
      .rpc('get_character_prompt_settings', { p_user_id: userId, p_character_id: characterId })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw new Error(`读取角色设定失败：${error.message}`, { cause: error });
    const row = (Array.isArray(data) ? data[0] : data) as
      | { character_notes: string | null; persona_description: string | null }
      | undefined;
    return {
      notes: row?.character_notes ?? '',
      personaDescription: row?.persona_description ?? '',
    };
  }
}
