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
import { MiniappUserSettingsRepository } from '../../infrastructure/repositories/MiniappUserSettingsRepository.js';
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

export interface EffectiveStatusBar {
  source: StatusBarSource;
  template: StatusBarTemplate | null;
  cardTemplate: StatusBarTemplate | null;
  character: { name: string; description: string };
}

let repoInstance: StatusBarRepository | null = null;
let settingsInstance: MiniappUserSettingsRepository | null = null;
export const statusRepo = () => (repoInstance ??= new StatusBarRepository());
const settings = () => (settingsInstance ??= new MiniappUserSettingsRepository());

/** 聊天页用：带上玩家的"状态栏"总开关。 */
export async function resolveEffectiveStatusBar(input: {
  userId: string;
  characterId: string;
  sessionId?: string;
  respectToggle: boolean;
}): Promise<EffectiveStatusBar> {
  const repo = statusRepo();
  const [runtime, override, config] = await Promise.all([
    repo.readCharacterRuntime(input.characterId, input.userId, input.sessionId),
    repo.readOverride(input.userId, input.characterId),
    input.respectToggle ? settings().getGenerationConfig(input.userId) : null,
  ]);
  const cardTemplate = parseUsableTemplate(runtime.statusBar);
  const player = parseUsableTemplate(override);
  const character = { name: runtime.name, description: runtime.description };
  if (config && config.pref_show_status === false)
    return { source: 'none', template: null, cardTemplate, character };
  if (player) return { source: 'player', template: player, cardTemplate, character };
  if (cardTemplate) return { source: 'card', template: cardTemplate, cardTemplate, character };
  return { source: 'auto', template: null, cardTemplate: null, character };
}
