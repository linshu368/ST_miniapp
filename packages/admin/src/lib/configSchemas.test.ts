import { describe, expect, it } from 'vitest';
import {
  configMetadata,
  configSchemas,
  LlmPricingConfigSchema,
  managedConfigKeys,
  EditableReplyStyleOptionsConfigSchema,
  isTextManagedConfig,
  EditableImagePlazaTagConfigSchema,
  EditableModelCatalogSchema,
  normalizeVideoPlazaCatalogOptions,
} from './configSchemas';

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
    catalog.first_token_deadline_ms = 8000;
    catalog.fallback_timeout_ms = 2500;
    catalog.first_token_timeout_rate_target = 0.02;
    catalog.tiers[0]!.models[0]!.first_token_timeout_ms = 7500;
    const edited = EditableModelCatalogSchema.parse(catalog);
    expect(configSchemas.llm_model_catalog.parse(edited)).toEqual(catalog);
  });
});

describe('video plaza managed catalog', () => {
  it('registers a valid six-model draft and rejects unsafe publish shapes', () => {
    const key = 'image_plaza_video_model_catalog' as const;
    expect(managedConfigKeys).toContain(key);
    const catalog = configSchemas[key].parse(configMetadata[key].defaultValue);
    expect(catalog.models).toHaveLength(6);
    const normalized = normalizeVideoPlazaCatalogOptions(catalog);
    expect(normalized.models.every((model) => model.durations.join(',') === '5,10')).toBe(true);
    expect(
      normalized.models.every((model) => model.aspect_ratios.join(',') === '16:9,9:16,1:1')
    ).toBe(true);
    expect(
      normalized.models.every((model) =>
        model.resolutions.every((resolution) =>
          ['720p', '1080p'].includes(resolution.toLowerCase())
        )
      )
    ).toBe(true);
    const disabledDefault = structuredClone(catalog);
    disabledDefault.models.find(
      (model: { id: string }) => model.id === disabledDefault.default_model_id
    )!.enabled = false;
    expect(configSchemas[key].safeParse(disabledDefault).success).toBe(false);
    const missingPrice = structuredClone(catalog);
    delete missingPrice.models[0]!.price_matrix[
      Object.keys(missingPrice.models[0]!.price_matrix)[0]!
    ];
    expect(configSchemas[key].safeParse(missingPrice).success).toBe(false);
  });

  it('narrows a legacy provider superset and rebuilds its price matrix before saving', () => {
    const key = 'image_plaza_video_model_catalog' as const;
    const legacy = configSchemas[key].parse(configMetadata[key].defaultValue);
    const model = legacy.models[0]!;
    model.durations = [2, 5, 10];
    model.resolutions = ['1080p', '2k'];
    model.aspect_ratios = ['16:9', '9:16', '1:1', '4:3'];
    model.default_duration = 2;
    model.default_resolution = '2k';
    model.default_aspect_ratio = '4:3';
    model.price_matrix = Object.fromEntries(
      model.durations.flatMap((duration: number) =>
        model.resolutions.flatMap((resolution: string) =>
          [false, true].map((audio) => [
            `${duration}|${resolution}|${audio ? 1 : 0}`,
            duration === 5 && resolution === '1080p' && audio ? 35 : 1,
          ])
        )
      )
    );

    const parsed = configSchemas[key].parse(legacy);
    expect(parsed.models[0]).toMatchObject({
      durations: [5, 10],
      resolutions: ['1080p'],
      aspect_ratios: ['16:9', '9:16', '1:1'],
      default_duration: 5,
      default_resolution: '1080p',
      default_aspect_ratio: '16:9',
    });
    expect(parsed.models[0]!.price_matrix).toEqual({
      '5|1080p|0': 1,
      '5|1080p|1': 35,
      '10|1080p|0': 1,
      '10|1080p|1': 1,
    });
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
