/**
 * 玩家在工具箱里让状态栏 AI 帮忙：按方向生成整栏、按方向改整栏、帮写一项说明。
 * 只对玩家自己、只对这张卡；不扣星尘。结果只回给前端，玩家确认后照常走 PUT 保存（同一套校验）。
 *
 * 角色资料按卡从库里读（和运营批量同一套拼法），不从前端传；先按读取接口的规则确认这张卡对玩家可用。
 * 玩家对内容有绝对决定权：提示词里玩家的方向优先于作者设计和角色资料，AI 只守格式。
 */
import type { PlayerStatusBarAiData, PlayerStatusBarAiRequest } from '@miniapp/shared';
import { CharacterCardRepository } from '../../infrastructure/repositories/CharacterCardRepository.js';
import {
  describeCreatorStatusBarItem,
  editCreatorStatusBar,
  generateCreatorStatusBar,
} from '../generation/creator-status-bar.js';
import { draftFromCard } from './admin.js';
import { resolveEffectiveStatusBar, StatusBarError } from './template.js';

let repoInstance: CharacterCardRepository | null = null;
const cards = () => (repoInstance ??= new CharacterCardRepository());

export async function runPlayerStatusBarAi(
  userId: string,
  characterId: string,
  request: PlayerStatusBarAiRequest,
  signal: AbortSignal
): Promise<PlayerStatusBarAiData> {
  // 卡不存在或玩家看不到时这里就会抛（P0404），和读取接口一致
  await resolveEffectiveStatusBar({ userId, characterId });
  const row = await cards().readStatusBarSource(characterId);
  if (!row) throw new StatusBarError('STATUS_NOT_FOUND', '角色不存在');
  const draft = draftFromCard(row);
  switch (request.action) {
    case 'generate': {
      const result = await generateCreatorStatusBar(draft, signal, {
        direction: request.direction,
        audience: 'player',
      });
      return { action: 'generate', ...result };
    }
    case 'edit': {
      const result = await editCreatorStatusBar(
        draft,
        request.template,
        request.instruction,
        signal,
        'player'
      );
      return { action: 'edit', ...result };
    }
    case 'describe':
      return {
        action: 'describe',
        desc: await describeCreatorStatusBarItem(draft, request.item, signal, 'player'),
      };
  }
}
