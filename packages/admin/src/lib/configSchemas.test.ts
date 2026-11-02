import { describe, expect, it } from 'vitest';
import {
  CREATOR_REVIEW_PROMPT_KEY,
  CreatorReviewPromptSchema,
  DEFAULT_CREATOR_REVIEW_PROMPT,
  DEFAULT_LOBBY_RANKING_PARAMS,
  DEFAULT_LOBBY_ROTATION_CONFIG,
} from '@miniapp/shared';
import { resolveLobbyRankingEditorValue } from '../components/LobbyRankingParamsEditor';
import {
  configMetadata,
  configSchemas,
  LlmPricingConfigSchema,
  managedConfigKeys,
  EditableReplyStyleOptionsConfigSchema,
  isTextManagedConfig,
  resolveManagedWorkingValue,
  EditableImagePlazaTagConfigSchema,
  EditableModelCatalogSchema,
} from './configSchemas';

describe('lobby rotation config editing', () => {
  it('opens legacy ranking settings with rotation disabled and a 24 hour interval', () => {
    const value = resolveLobbyRankingEditorValue(DEFAULT_LOBBY_RANKING_PARAMS);
    expect(value.rotation).toEqual(DEFAULT_LOBBY_ROTATION_CONFIG);
    expect(value.rotation).toMatchObject({ enabled: false, interval_hours: 24 });
    expect(configSchemas.lobby_ranking_params.safeParse(value).success).toBe(true);
  });

  it('preserves a saved rotation policy when editing the scoring settings', () => {
    const rotation = {
      enabled: true,
      interval_hours: 48,
      max_repeat: 1,
      exploration_count: 0,
      rollout_percent: 25,
    };
    const value = resolveLobbyRankingEditorValue({
      ...DEFAULT_LOBBY_RANKING_PARAMS,
      rotation,
      min_users: 30,
      first_touch_lookback_days: null,
    });
    expect(value.rotation).toEqual(rotation);
    expect(value.min_users).toBe(30);
    expect(value.first_touch_lookback_days).toBeNull();
    expect(configSchemas.lobby_ranking_params.parse(value)).toMatchObject({ rotation });
  });

  it('retains the legacy candidate list and independent fixed choice through save validation', () => {
    const characterIds = Array.from(
      { length: 8 },
      (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    );
    expect(configSchemas.lobby_pinned_characters.parse({ character_ids: characterIds })).toEqual({
      character_ids: characterIds,
    });
    expect(
      configSchemas.lobby_pinned_characters.parse({
        character_ids: characterIds,
        fixed_character_id: characterIds[5],
      })
    ).toMatchObject({ character_ids: characterIds, fixed_character_id: characterIds[5] });
    expect(configMetadata.lobby_pinned_characters.label).toBe('推荐主推候选');
  });
});

describe('editable image plaza tags', () => {
  it('preserves blank text, whitespace and duplicate IDs while strict save validation rejects them', () => {
    const tags = [
      { id: '', label: ' 新标签 ', enabled: true, sort_order: 0 },
      { id: '', label: '', enabled: false, sort_order: 1 },
    ];
    expect(EditableImagePlazaTagConfigSchema.parse(tags)).toEqual(tags);
    expect(configSchemas.image_plaza_tags.safeParse(tags).success).toBe(false);
    expect(EditableImagePlazaTagConfigSchema.safeParse([{ id: 1 }]).success).toBe(false);
  });
});

const validConfig = {
  fixedDeduction: {
    freeQuotaExhausted: 10,
    light: 15,
    standard: 30,
    premium: 50,
  },
};

describe('LlmPricingConfigSchema', () => {
  it('accepts fixed per-round deduction amounts', () => {
    expect(LlmPricingConfigSchema.parse(validConfig).fixedDeduction).toEqual({
      freeQuotaExhausted: 10,
      light: 15,
      standard: 30,
      premium: 50,
    });
  });

  it('rejects missing or negative fixed deductions', () => {
    expect(
      LlmPricingConfigSchema.safeParse({ ...validConfig, fixedDeduction: undefined }).success
    ).toBe(false);
    expect(
      LlmPricingConfigSchema.safeParse({
        ...validConfig,
        fixedDeduction: { ...validConfig.fixedDeduction, premium: -1 },
      }).success
    ).toBe(false);
    expect(
      LlmPricingConfigSchema.safeParse({
        ...validConfig,
        fixedDeduction: {
          freeQuotaExhausted: 10,
          standard: 30,
          premium: 50,
        },
      }).success
    ).toBe(false);
  });
});

describe('VIP media config registration', () => {
  it('does not expose removed advanced image configs', () => {
    expect(managedConfigKeys.some((key) => key.startsWith('image_advanced_'))).toBe(false);
  });

  it('bounds media free-trial limits', () => {
    const key = 'media_feature_free_trial_limit';

    expect(configSchemas[key].safeParse(1).success).toBe(true);
    expect(configSchemas[key].safeParse(100).success).toBe(true);
    expect(configSchemas[key].safeParse(0).success).toBe(false);
    expect(configSchemas[key].safeParse(101).success).toBe(false);
  });
});

describe('recharge page config registration', () => {
  it('exposes the recharge page in the managed config directory with a valid default', () => {
    const key = 'miniapp_recharge_page_config';

    expect(managedConfigKeys).toContain(key);
    expect(configMetadata[key].label).toBe('充值页面配置');
    expect(configSchemas[key].safeParse(configMetadata[key].defaultValue).success).toBe(true);
    expect(configMetadata[key].defaultValue).toMatchObject({
      pending_arrival_hint: '完成付款后积分将自动到账，通常不超过 3 分钟',
    });
  });
});

describe('payment prompt dialog config registration', () => {
  it('exposes the dialog in the managed config directory with a valid default', () => {
    const key = 'miniapp_payment_prompt_dialog_config';

    expect(managedConfigKeys).toContain(key);
    expect(configMetadata[key].label).toBe('支付提示弹窗');
    expect(configSchemas[key].safeParse(configMetadata[key].defaultValue).success).toBe(true);
  });
});

describe('llm provider routing config registration', () => {
  it('exposes provider routing in the managed config directory with a valid empty default', () => {
    const key = 'llm_provider_routing_config';

    expect(managedConfigKeys).toContain(key);
    expect(configMetadata[key].label).toBe('模型供应商路由');
    expect(configSchemas[key].safeParse(configMetadata[key].defaultValue).success).toBe(true);
    expect(configMetadata[key].defaultValue).toEqual({ rules: [] });
  });

  it('accepts per-model rules and rejects rules without any provider', () => {
    const key = 'llm_provider_routing_config';

    expect(
      configSchemas[key].safeParse({
        rules: [
          {
            openrouter_model_id: 'deepseek/deepseek-chat-v3.2',
            blocked_providers: ['alibaba'],
            preferred_providers: [],
            note: 'Alibaba 失败率 52.78%',
          },
        ],
      }).success
    ).toBe(true);

    expect(
      configSchemas[key].safeParse({
        rules: [
          {
            openrouter_model_id: 'deepseek/deepseek-chat-v3.2',
            blocked_providers: [],
            preferred_providers: [],
            note: '',
          },
        ],
      }).success
    ).toBe(false);
  });
});

describe('platform instruction slot registration', () => {
  it('uses the Shared strict schema for each independently managed slot', () => {
    for (const key of ['choice_rules', 'status_rules', 'memory_rules'] as const) {
      expect(managedConfigKeys).toContain(key);
      expect(configSchemas[key].safeParse(configMetadata[key].defaultValue).success).toBe(true);
      expect(configSchemas[key].safeParse({ on_first_two_turns: 'full', off: 'off' }).success).toBe(
        false
      );
    }
  });

  it('requires all current template placeholders instead of the retired mode token', () => {
    expect(
      configSchemas.system_instructions.safeParse(configMetadata.system_instructions.defaultValue)
        .success
    ).toBe(true);
    expect(
      configSchemas.system_instructions.safeParse(
        '{{INTERACTION_MODE}} {{WORD_COUNT}} {{USER_CUSTOM_INSTRUCTIONS}}'
      ).success
    ).toBe(false);
  });
});

describe('fallback managed configuration', () => {
  it('preserves fallback selection, shared deadline and overlapping launch thresholds through editor and save parsing', () => {
    const catalog = configSchemas.llm_model_catalog.parse(
      configMetadata.llm_model_catalog.defaultValue
    );
    catalog.fallback_model_id = 'vendor/operator-flash';
    catalog.fallback_provider_routes = [
      { model_id: 'vendor/operator-flash', preferred_providers: ['fast-one', 'fast-two'] },
    ];
    catalog.first_token_deadline_ms = 8000;
    catalog.fallback_timeout_ms = 2500;
    catalog.first_token_timeout_rate_target = 0.02;
    catalog.tiers[0]!.models[0]!.first_token_timeout_ms = 7500;
    const edited = EditableModelCatalogSchema.parse(catalog);
    expect(configSchemas.llm_model_catalog.parse(edited)).toEqual(catalog);
  });
});

describe('reply style options configuration', () => {
  const blankOption = {
    id: 'style-example',
    name: '',
    description: '',
    marker: '',
    rules: '',
    enabled: true,
  };
  it('registers one independent JSON configuration with an empty default', () => {
    expect(managedConfigKeys).toContain('reply_style_options');
    expect(isTextManagedConfig('reply_style_options')).toBe(false);
    expect(configMetadata.reply_style_options.defaultValue).toEqual({ options: [] });
    expect(configSchemas.reply_style_options.parse({ options: [] })).toEqual({ options: [] });
  });
  it('preserves incomplete edit rows but requires a name when saving', () => {
    const value = { options: [blankOption] };
    expect(EditableReplyStyleOptionsConfigSchema.parse(value)).toEqual(value);
    expect(configSchemas.reply_style_options.safeParse(value).success).toBe(false);
    expect(
      configSchemas.reply_style_options.parse({
        options: [{ ...blankOption, name: ' 自定义名称 ' }],
      })
    ).toEqual({ options: [{ ...blankOption, name: '自定义名称' }] });
  });
  it('rejects duplicate nonblank markers while allowing independent empty rule fields', () => {
    const first = { ...blankOption, name: '选项一' };
    const second = { ...blankOption, id: 'style-example-two', name: '选项二' };
    expect(configSchemas.reply_style_options.safeParse({ options: [first, second] }).success).toBe(
      true
    );
    expect(
      configSchemas.reply_style_options.safeParse({
        options: [
          { ...first, marker: '{{EXAMPLE}}' },
          { ...second, marker: '{{EXAMPLE}}' },
        ],
      }).success
    ).toBe(false);
  });
});

describe('creator character review prompt registration', () => {
  it('uses an independent text-only policy body with the shared schema and default', () => {
    const key = CREATOR_REVIEW_PROMPT_KEY;
    expect(managedConfigKeys).toContain(key);
    expect(isTextManagedConfig(key)).toBe(true);
    expect(configMetadata[key].label).toBe('角色卡审核');
    expect(configSchemas[key]).toBe(CreatorReviewPromptSchema);
    expect(configMetadata[key].defaultValue).toBe(DEFAULT_CREATOR_REVIEW_PROMPT);
    expect(configSchemas[key].parse('  只审核角色是否完整可玩。  ')).toBe(
      '只审核角色是否完整可玩。'
    );
    expect(configSchemas[key].safeParse('   ').success).toBe(false);
    expect(configSchemas[key].safeParse('x'.repeat(12001)).success).toBe(false);
    expect(configSchemas[key].safeParse({ approved: true, reason: '通过' }).success).toBe(false);
  });

  it('loads the draft text before published text and falls back to the example policy', () => {
    const key = CREATOR_REVIEW_PROMPT_KEY;
    expect(
      resolveManagedWorkingValue({
        key,
        draft: { value: { ignored: true }, text_value: '未发布规则正文' },
        config: { value: null, text_value: '已发布规则正文' },
      })
    ).toBe('未发布规则正文');
    expect(
      resolveManagedWorkingValue({
        key,
        draft: null,
        config: { value: null, text_value: '已发布规则正文' },
      })
    ).toBe('已发布规则正文');
    expect(resolveManagedWorkingValue({ key, draft: null, config: null })).toBe(
      DEFAULT_CREATOR_REVIEW_PROMPT
    );
  });
});
