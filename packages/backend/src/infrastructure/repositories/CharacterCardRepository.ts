// 角色卡的引擎字段读取通道（M3b）。
//
// 引擎组 prompt 只需要 miniapp.characters 的基础字段组（总方案决策 4：不换格式、不重新设计字段）。
// v1 实际只消费 system_prompt，其余字段照常取出——接缝 EngineCharacter 保留了完整字段组，
// 日后把人设并入 system 段时只改引擎实现，不必回来改取数。
//
// 与仓库层的既有纪律一致：这里只返回行形态，转成 EngineCharacter 的动作归 features/conversations，
// 仓库不依赖引擎类型。

import { getSupabaseClient } from '../../lib/supabase.js';
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
}

const CARD_COLUMNS =
  'id, name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions';

export class CharacterCardRepository {
  private readonly db = getSupabaseClient().schema('miniapp');

  /**
   * 不过滤 enabled / archived_at：会话一旦建立，角色卡后续下架也要能把已有会话聊完，
   * 拦在建会话入口（大厅列表本身就只出可见的卡）比拦在每一轮生成上合理。
   */
  async requireCard(characterId: string): Promise<CharacterCardRow> {
    const { data, error } = await this.db
      .from('characters')
      .select(CARD_COLUMNS)
      .eq('id', characterId)
      .maybeSingle();

    if (error) throw new Error(`查询角色卡失败：${error.message}`);
    if (!data) {
      throw new ConversationRepositoryError('character_not_found', `角色卡不存在：${characterId}`);
    }
    return data as CharacterCardRow;
  }
}
