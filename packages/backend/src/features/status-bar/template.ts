/**
 * 生效模板的解析：玩家改过的 > 卡自带的 > 自动（旧卡没有状态栏）；玩家关了总开关 = none。
 * 存储里的 JSON 都要重新过结构与语义校验，任何一份不合格就当作没有（不让坏数据进提示词）。
 */
import {
  StatusBarTemplateDraftSchema,
  checkStatusBarTemplate,
  type StatusBarSource,
  type StatusBarTemplate,
} from '@miniapp/shared';
import { StatusBarRepository } from '../../infrastructure/repositories/StatusBarRepository.js';

export class StatusBarError extends Error {
  constructor(
    readonly code:
      | 'STATUS_NOT_FOUND'
      | 'STATUS_DISABLED'
      | 'STATUS_VIP_REQUIRED'
      | 'STATUS_RATE_LIMITED'
      | 'STATUS_UPDATE_FAILED'
      | 'STATUS_INVALID_TEMPLATE',
    message: string
  ) {
    super(message);
  }
}

export function parseUsableTemplate(raw: unknown): StatusBarTemplate | null {
  if (raw === null || raw === undefined) return null;
  const parsed = StatusBarTemplateDraftSchema.safeParse(raw);
  if (!parsed.success) return null;
  return checkStatusBarTemplate(parsed.data).length === 0 ? parsed.data : null;
}

interface EffectiveBase {
  cardTemplate: StatusBarTemplate | null;
  character: { name: string; description: string };
}

/** none：卡和玩家都没有状态栏——不显示、不更新（不再有"模型自己挑"的通用模板）。 */
export type EffectiveStatusBar = EffectiveBase &
  (
    | { source: Exclude<StatusBarSource, 'none'>; template: StatusBarTemplate }
    | { source: 'none'; template: null }
  );

let repoInstance: StatusBarRepository | null = null;
export const statusRepo = () => (repoInstance ??= new StatusBarRepository());

/** 卡上有状态栏就显示（玩家改过的优先）；回复偏好里不再有状态栏开关。 */
export async function resolveEffectiveStatusBar(input: {
  userId: string;
  characterId: string;
  sessionId?: string;
}): Promise<EffectiveStatusBar> {
  const repo = statusRepo();
  const [runtime, override] = await Promise.all([
    repo.readCharacterRuntime(input.characterId, input.userId, input.sessionId),
    repo.readOverride(input.userId, input.characterId),
  ]);
  const cardTemplate = parseUsableTemplate(runtime.statusBar);
  const player = parseUsableTemplate(override);
  const character = { name: runtime.name, description: runtime.description };
  if (player) return { source: 'player', template: player, cardTemplate, character };
  if (cardTemplate) return { source: 'card', template: cardTemplate, cardTemplate, character };
  return { source: 'none', template: null, cardTemplate: null, character };
}
