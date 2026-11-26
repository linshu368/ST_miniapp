import {
  PutCharacterMySettingsRequestSchema,
  PutCharacterStatusBarRequestSchema,
  STATUS_BAR_EXAMPLES,
  type CharacterStatusBarData,
  type GetCharacterMySettingsData,
  type StatusBarTemplate,
} from '@miniapp/shared';

/** 工具箱「对话设置」：我的人设、补充设定、状态栏。虚构数据，只在内存里改。 */
export function createChatToolsFixture() {
  const initial = (): GetCharacterMySettingsData => ({
    notes: '',
    persona: { mode: 'default', persona_id: null },
    personas: [
      {
        id: '8a000000-0000-4000-8000-000000000001',
        name: '夜班调酒师',
        description: '二十六岁，夜班调酒师，话不多，记性很好。',
        is_default: true,
      },
      {
        id: '8a000000-0000-4000-8000-000000000002',
        name: '旅行摄影师',
        description: '三十岁，到处拍照，习惯先观察再开口。',
        is_default: false,
      },
    ],
  });
  const card: StatusBarTemplate = STATUS_BAR_EXAMPLES[0]!.template;
  let settings = initial();
  let mine: StatusBarTemplate | null = null;
  const statusBar = (): CharacterStatusBarData => ({
    source: mine ? 'player' : 'card',
    template: mine ?? card,
    cardTemplate: card,
  });
  return {
    reset() {
      settings = initial();
      mine = null;
    },
    handle(method: string, path: string, body: unknown): unknown | undefined {
      if (/^\/api\/characters\/[^/]+\/my-settings$/.test(path)) {
        if (method === 'PUT') {
          settings = { ...settings, ...PutCharacterMySettingsRequestSchema.parse(body) };
        }
        return settings;
      }
      if (/^\/api\/characters\/[^/]+\/status-bar$/.test(path)) {
        if (method === 'PUT') mine = PutCharacterStatusBarRequestSchema.parse(body).template;
        if (method === 'DELETE') mine = null;
        return statusBar();
      }
      return undefined;
    },
  };
}
