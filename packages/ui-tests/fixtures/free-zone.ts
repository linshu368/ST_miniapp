import {
  GetModelCatalogDataSchema,
  isFreeZoneModelId,
  type GetModelCatalogData,
  type PublicFreeZone,
} from '@miniapp/shared';
import type { PreviewData } from './data.js';

/**
 * 畅聊栏目的本地预览数据：虚构的付费三档 + 免费栏目各状态。模型名只是示意，
 * 不对应线上配置，也不连接 Surplus。
 */
export const FREE_ZONE_SCENARIOS = {
  'free-zone': {
    label: '畅聊开放',
    description: '免费栏目开放中，显示结束时间；可选免费模型，顶栏挂「畅聊中」角标',
  },
  'free-zone-not-started': {
    label: '畅聊未开始',
    description: '福利期还没开始：栏目默认折叠，显示开始时间，点模型只提示',
  },
  'free-zone-own-card': {
    label: '畅聊仅限自创卡',
    description: '范围限自创角色卡，当前是别人的卡：显示「仅限自创角色卡」',
  },
  'free-zone-replaced': {
    label: '畅聊模型下架',
    description: '原来选的免费模型被下架，已自动换成同系列模型（不弹提示）',
  },
} as const;

export type FreeZoneScenario = keyof typeof FREE_ZONE_SCENARIOS;

export function isFreeZoneScenario(value: string): value is FreeZoneScenario {
  return Object.hasOwn(FREE_ZONE_SCENARIOS, value);
}

const RULES =
  '福利期：和自己创作的角色卡聊天，下面的模型全部免费。\n其他角色卡将在每周畅聊日开放，具体时间另行通知。';

const MODELS: PublicFreeZone['models'] = [
  {
    id: 'free-glm-5-2',
    display_name: 'GLM 5.2 fast',
    tagline: '中文专精，剧情推理巅峰',
    benchmark_tier: 'premium',
    original_credits: 55,
    // 关不掉思考：选它后关深度思考会轻提示
    thinking: 'always',
  },
  {
    id: 'free-deepseek-v4-pro',
    display_name: 'DeepSeek V4 Pro',
    tagline: '性价比之王，稳定，几乎无甲',
    benchmark_tier: 'standard',
    original_credits: 33,
    thinking: 'switchable',
  },
  {
    id: 'free-gemini-3-5-flash',
    display_name: 'Gemini 3.5 Flash',
    tagline: 'NSFW场景好',
    benchmark_tier: 'light',
    original_credits: 15,
    thinking: 'switchable',
  },
];

function atLocal(daysFromToday: number, hours: number, minutes = 0): string {
  const at = new Date();
  at.setDate(at.getDate() + daysFromToday);
  at.setHours(hours, minutes, 0, 0);
  return at.toISOString();
}

function catalog(base: GetModelCatalogData): GetModelCatalogData['catalog'] {
  const light = base.catalog.tiers[0]!;
  return {
    ...base.catalog,
    tiers: [
      { ...light, label: '轻量', color: '#4ade80', cost_hint: '轻量模型，每轮对话消耗15星尘' },
      {
        key: 'standard',
        label: '标准',
        color: '#818cf8',
        cost_hint: '标准模型，每轮对话固定消耗 33星尘',
        sort_order: 1,
        locked: true,
        requires_vip: true,
        models: [
          {
            id: 'preview-standard',
            display_name: '溪流引擎',
            tagline: '本地模拟标准档',
            is_free: false,
            sort_order: 0,
          },
        ],
      },
      {
        key: 'premium',
        label: '旗舰',
        color: '#c084fc',
        cost_hint: '旗舰模型，每轮对话固定消耗 55星尘',
        sort_order: 2,
        locked: true,
        requires_vip: true,
        models: [
          {
            id: 'preview-premium',
            display_name: '星海引擎',
            tagline: '本地模拟旗舰档',
            is_free: false,
            sort_order: 0,
          },
        ],
      },
    ],
  };
}

function zoneFor(scenario: FreeZoneScenario): PublicFreeZone {
  const base = { rules: RULES, models: MODELS };
  switch (scenario) {
    case 'free-zone-not-started':
      return { state: 'not_started', starts_at: atLocal(1, 20), ...base };
    case 'free-zone-own-card':
      return { state: 'own_card_only', ...base };
    case 'free-zone':
    case 'free-zone-replaced':
      return { state: 'open', ends_at: atLocal(5, 23, 59), ...base };
  }
}

export function applyFreeZoneScenario(data: PreviewData, scenario: string): void {
  if (!isFreeZoneScenario(scenario)) return;
  const replaced = scenario === 'free-zone-replaced';
  data.models = GetModelCatalogDataSchema.parse({
    ...data.models,
    catalog: catalog(data.models),
    free_zone: zoneFor(scenario),
    ...(replaced
      ? {
          selected_model_id: 'free-glm-5-2',
          selected_openrouter_model_id: 'glm-5.2',
          selected_provider: 'surplus',
          selected_provider_model_id: 'glm-5.2',
        }
      : {}),
  });
}

/** 预览里的切换：只有开放时能选栏目里的模型。返回 null 表示不是免费模型。 */
export function selectFreeZonePreviewModel(
  data: PreviewData,
  modelId: string
): 'ok' | 'closed' | null {
  if (!isFreeZoneModelId(modelId)) return null;
  const zone = data.models.free_zone;
  const model = zone?.models.find((item) => item.id === modelId);
  if (!zone || zone.state !== 'open' || !model) return 'closed';
  Object.assign(data.models, {
    selected_model_id: model.id,
    selected_openrouter_model_id: model.id.replace(/^free-/, ''),
    selected_provider: 'surplus',
    selected_provider_model_id: model.id.replace(/^free-/, ''),
  });
  data.generation.config.selected_model_id = model.id;
  return 'ok';
}
