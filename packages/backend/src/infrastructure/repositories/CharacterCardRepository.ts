// 角色卡的引擎字段读取通道（M3b）。
//
// 引擎组 prompt 只需要 app_core.characters 的基础字段组（总方案决策 4：不换格式、不重新设计字段）。
// v1 实际只消费 system_prompt，其余字段照常取出——接缝 EngineCharacter 保留了完整字段组，
// 日后把人设并入 system 段时只改引擎实现，不必回来改取数。
//
// 与仓库层的既有纪律一致：这里只返回行形态，转成 EngineCharacter 的动作归 features/conversations，
// 仓库不依赖引擎类型。

import { getDomainDb } from '../../lib/supabase.js';
import { ConversationRepositoryError } from './conversation-errors.js';

export interface CharacterCardRow {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  post_history_instructions: string;
  character_persona_and_style: string | null;
}

export class CharacterCardRepository {
  private readonly db = getDomainDb('app_core');

  /** Official historical sessions keep their prior behavior. Creator cards enforce access,
   * and only their author receives the draft projection when trying an unpublished edit. */
  async requireCard(
    characterId: string,
    userId: string,
    sessionId: string
  ): Promise<CharacterCardRow> {
    const { data, error } = await this.db
      .rpc('read_session_character_runtime', {
        p_character_id: characterId,
        p_user_id: userId,
        p_session_id: sessionId,
        p_opening_only: false,
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error || !data) {
      if (error?.code === 'P0404' || (!error && !data)) {
        throw new ConversationRepositoryError('character_not_found', '角色已不可用');
      }
      throw new Error('查询角色卡失败');
    }
    return data as CharacterCardRow;
  }
}
