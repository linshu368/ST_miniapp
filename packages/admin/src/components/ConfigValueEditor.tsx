import { useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import {
  DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
  DEFAULT_PAYMENT_CHANNELS_CONFIG,
  DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  DEFAULT_RECHARGE_PAGE_CONFIG,
  DEFAULT_WORD_COUNT_TIERS_CONFIG,
  FreeQuotaExhaustedDialogConfigSchema,
  ImagePlazaModelCatalogSchema,
  ImagePlazaShareTipConfigSchema,
  ImagePlazaTagConfigSchema,
  LlmPricingConfigSchema,
  MAX_FEATURE_FREE_TRIAL_LIMIT,
  ModelCatalogSchema,
  PaymentPromptDialogConfigSchema,
  RechargePageConfigSchema,
  type ModelCatalog,
  type LlmModelProvider,
  type OpenRouterModelDirectory,
  type PaymentPlan,
  type PaymentPlansConfig,
  type ProviderModelDirectory,
  type WordCountTiersConfig,
  type InstructionSlotRules,
  type AdminImageTextModelTestRequest,
  type AdminImageTextModelTestResponse,
} from '@miniapp/shared';
import {
  configMetadata,
  DEFAULT_INVITE_CENTER_CONFIG,
  DEFAULT_INVITE_REWARD_RULES,
  EditableModelCatalogSchema,
  EditableImagePlazaTagConfigSchema,
  ImageTextModelConfigSchema,
  type InviteCenterConfig,
  type InviteRewardRulesConfig,
  type ImageTextModelConfig,
  type ManagedConfigKey,
} from '../lib/configSchemas';
import type { CharacterCard } from '../lib/adminApi';
import { InviteCenterConfigEditor } from './InviteCenterConfigEditor';
import { InviteRewardRulesEditor } from './InviteRewardRulesEditor';
import {
  ImagePlazaModelCatalogEditor,
  ImagePlazaShareTipEditor,
  ImagePlazaTagsEditor,
} from './ImagePlazaConfigEditors';
import { LobbyPinnedCharactersEditor } from './LobbyPinnedCharactersEditor';
import { LobbyRankingParamsEditor } from './LobbyRankingParamsEditor';
import { ModelCatalogEditor } from './ModelCatalogEditor';
import { FallbackConfigEditor } from './FallbackConfigEditor';
import { PaymentPromptDialogConfigEditor } from './PaymentPromptDialogConfigEditor';
import { ProviderRoutingConfigEditor } from './ProviderRoutingConfigEditor';
import { RechargePageConfigEditor } from './RechargePageConfigEditor';
import { SystemInstructionsEditor } from './SystemInstructionsEditor';
import { PlatformInstructionSlotRulesEditor } from './PlatformInstructionSlotRulesEditor';
import { WordCountTiersEditor } from './WordCountTiersEditor';

function asWordCountTiersConfig(value: unknown): WordCountTiersConfig {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as WordCountTiersConfig).tiers)
  ) {
    const record = value as WordCountTiersConfig;
    return {
      tiers: record.tiers,
      default_tier_id: record.default_tier_id || DEFAULT_WORD_COUNT_TIERS_CONFIG.default_tier_id,
      layout: {
        columns:
          record.layout?.columns === 2 ||
          record.layout?.columns === 3 ||
          record.layout?.columns === 4
            ? record.layout.columns
            : 4,
      },
    };
  }
  return structuredClone(DEFAULT_WORD_COUNT_TIERS_CONFIG);
}

/**
 * 宽松结构归一化（对齐 asWordCountTiersConfig 的做法）：
 * 只校验形状不校验取值，编辑中间态（清空文案、清空数字）不会把整个表单打回默认值；
 * 取值合法性由保存时的 zod + DB 校验兜底。
 */
function asInviteRewardRules(value: unknown): InviteRewardRulesConfig {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as InviteRewardRulesConfig).rules)
  ) {
    const record = value as InviteRewardRulesConfig;
    return {
      total_cap_credits:
        typeof record.total_cap_credits === 'number'
          ? record.total_cap_credits
          : DEFAULT_INVITE_REWARD_RULES.total_cap_credits,
      rules: record.rules.map((rule) => ({
        rule_key: typeof rule?.rule_key === 'string' ? rule.rule_key : '',
        credits: typeof rule?.credits === 'number' ? rule.credits : 1,
        enabled: rule?.enabled === true,
        ...(typeof rule?.threshold_rounds === 'number'
          ? { threshold_rounds: rule.threshold_rounds }
          : {}),
      })),
    };
  }
  return structuredClone(DEFAULT_INVITE_REWARD_RULES);
}

function asInviteCenterConfig(value: unknown): InviteCenterConfig {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as InviteCenterConfig).copy_templates)
  ) {
    const record = value as InviteCenterConfig;
    return {
      poster_url: typeof record.poster_url === 'string' ? record.poster_url : '',
      copy_templates: record.copy_templates.map((template) =>
        typeof template === 'string' ? template : ''
      ),
    };
  }
  return structuredClone(DEFAULT_INVITE_CENTER_CONFIG);
}

function asPaymentPlansConfig(value: unknown): PaymentPlansConfig {
  if (Array.isArray(value)) {
    return { plans: value as PaymentPlan[], payment_channels: DEFAULT_PAYMENT_CHANNELS_CONFIG };
  }
  if (value && typeof value === 'object' && Array.isArray((value as PaymentPlansConfig).plans)) {
    const record = value as Partial<PaymentPlansConfig>;
    return {
      plans: record.plans ?? [],
      payment_channels: {
        alipay_enabled: record.payment_channels?.alipay_enabled === true,
        wxpay_enabled: record.payment_channels?.wxpay_enabled === true,
        default_payment_type:
          record.payment_channels?.default_payment_type === 'wxpay' ? 'wxpay' : 'alipay',
      },
    };
  }
  return { plans: [], payment_channels: DEFAULT_PAYMENT_CHANNELS_CONFIG };
}

function ImageTextModelConfigEditor(props: {
  value: ImageTextModelConfig;
  disabled?: boolean;
  onChange: (value: ImageTextModelConfig) => void;
  onTest: (value: AdminImageTextModelTestRequest) => Promise<AdminImageTextModelTestResponse>;
}) {
  const { message } = AntApp.useApp();
  const [testing, setTesting] = useState(false);

  const handleTest = async () => {
    const parsed = ImageTextModelConfigSchema.safeParse(props.value);
    if (!parsed.success) {
      message.error(parsed.error.issues[0]?.message ?? '请先填写有效的模型配置');
      return;
    }
    if (!parsed.data.url || !parsed.data.api_key || !parsed.data.model) {
      message.warning('请先填写 URL、API Key 和模型名称');
      return;
    }

    setTesting(true);
    try {
      const result = await props.onTest(parsed.data);
      message.success(`模型调用成功：${result.model}（${result.latency_ms}ms）`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '模型调用测试失败');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Alert
        type="warning"
        showIcon
        message="API Key 属于敏感配置"
        description="仅在对应环境保存和发布；界面预览会隐藏具体值。测试与生产环境需分别配置。"
      />
      <div>
        <Typography.Text strong>请求 URL</Typography.Text>
        <Input
          value={props.value.url}
          placeholder="请输入完整的 HTTPS Chat Completions 请求地址"
          disabled={props.disabled}
          onChange={(event) => props.onChange({ ...props.value, url: event.target.value })}
        />
      </div>
      <div>
        <Typography.Text strong>API Key</Typography.Text>
        <Input.Password
          value={props.value.api_key}
          autoComplete="new-password"
          placeholder="留空时与其他两项一起回退 DeepSeek"
          disabled={props.disabled}
          onChange={(event) => props.onChange({ ...props.value, api_key: event.target.value })}
        />
      </div>
      <div>
        <Typography.Text strong>模型名称</Typography.Text>
        <Input
          value={props.value.model}
          placeholder="模型 ID"
          disabled={props.disabled}
          onChange={(event) => props.onChange({ ...props.value, model: event.target.value })}
        />
      </div>
      <Button
        loading={testing}
        disabled={props.disabled || testing}
        onClick={() => void handleTest()}
      >
        测试模型调用
      </Button>
    </Space>
  );
}

export function ConfigValueEditor(props: {
  configKey: ManagedConfigKey;
  modelCatalogSection?: 'models' | 'fallback';
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  providerDirectories: Partial<Record<LlmModelProvider, ProviderModelDirectory>>;
  publishedModelIds: ReadonlySet<string>;
  syncLoading: Partial<Record<LlmModelProvider, boolean>>;
  syncError: Partial<Record<LlmModelProvider, string | null>>;
  onRefreshProvider: (provider: LlmModelProvider) => void;
  paymentPlans: PaymentPlan[];
  characters: CharacterCard[];
  charactersLoading: boolean;
  charactersError: string | null;
  onUploadInvitePoster: (file: File) => Promise<string>;
  onTestImageTextModel: (
    value: AdminImageTextModelTestRequest
  ) => Promise<AdminImageTextModelTestResponse>;
}) {
  const openRouterDirectory: OpenRouterModelDirectory | null = props.providerDirectories.openrouter
    ? {
        models: props.providerDirectories.openrouter.models.map((model) => ({
          id: model.id,
          canonical_slug: null,
          name: model.name,
          description: model.description,
          context_length: model.context_length,
          prompt_usd_per_token: model.prompt_usd_per_token,
          completion_usd_per_token: model.completion_usd_per_token,
          expiration_date: null,
        })),
        fetched_at: props.providerDirectories.openrouter.fetched_at,
        stale: props.providerDirectories.openrouter.stale,
      }
    : null;

  if (props.configKey === 'image_plaza_model_catalog') {
    const parsed = ImagePlazaModelCatalogSchema.safeParse(props.value);
    const fallback = ImagePlazaModelCatalogSchema.parse(
      configMetadata.image_plaza_model_catalog.defaultValue
    );
    return (
      <ImagePlazaModelCatalogEditor
        value={parsed.success ? parsed.data : fallback}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (props.configKey === 'image_plaza_share_tip') {
    const parsed = ImagePlazaShareTipConfigSchema.safeParse(props.value);
    const fallback = ImagePlazaShareTipConfigSchema.parse(
      configMetadata.image_plaza_share_tip.defaultValue
    );
    return (
      <ImagePlazaShareTipEditor
        value={parsed.success ? parsed.data : fallback}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (props.configKey === 'image_plaza_tags_feature_enabled') {
    const enabled = props.value === true;
    return (
      <Space align="center" size="middle">
        <Switch
          checked={enabled}
          disabled={props.disabled}
          onChange={(next) => props.onChange(next)}
        />
        <div>
          <Typography.Text strong>
            {enabled ? '分享自动打标已开启' : '分享自动打标已关闭'}
          </Typography.Text>
          <br />
          <Typography.Text type="secondary">
            仅控制分享时空标签时是否调用模型自动打标；广场仍展示标签，并按提示词中文译文筛选。
          </Typography.Text>
        </div>
      </Space>
    );
  }

  if (props.configKey === 'image_plaza_tags') {
    const parsed = EditableImagePlazaTagConfigSchema.safeParse(props.value);
    const fallback = ImagePlazaTagConfigSchema.parse(configMetadata.image_plaza_tags.defaultValue);
    return (
      <ImagePlazaTagsEditor
        value={parsed.success ? parsed.data : fallback}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (props.configKey === 'image_text_model_config') {
    const record =
      props.value && typeof props.value === 'object' && !Array.isArray(props.value)
        ? (props.value as Partial<ImageTextModelConfig>)
        : {};
    const value: ImageTextModelConfig = {
      url: typeof record.url === 'string' ? record.url : '',
      api_key: typeof record.api_key === 'string' ? record.api_key : '',
      model: typeof record.model === 'string' ? record.model : '',
    };
    return (
      <ImageTextModelConfigEditor
        value={value}
        disabled={props.disabled}
        onChange={props.onChange}
        onTest={props.onTestImageTextModel}
      />
    );
  }

  if (
    props.configKey === 'image_prompt_policy' ||
    props.configKey === 'image_default_art_style' ||
    props.configKey === 'image_description_system_prompt' ||
    props.configKey === 'image_price_label' ||
    props.configKey === 'image_prompt_over_limit_hint' ||
    props.configKey === 'image_description_failed_hint' ||
    props.configKey === 'image_generation_failed_hint' ||
    props.configKey === 'image_failed_unknown_hint'
  ) {
    return (
      <Input.TextArea
        value={typeof props.value === 'string' ? props.value : ''}
        rows={6}
        maxLength={
          props.configKey === 'image_description_system_prompt'
            ? 12000
            : props.configKey === 'image_prompt_policy' ||
                props.configKey === 'image_default_art_style'
              ? 1000
              : 200
        }
        showCount
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    );
  }

  if (props.configKey === 'image_generation_enabled') {
    return (
      <Space align="center" size="middle">
        <Switch
          checked={props.value === true}
          disabled={props.disabled}
          onChange={props.onChange}
        />
        <Typography.Text strong>
          {props.value === true ? '图片生成入口已开启' : '图片生成入口已关闭'}
        </Typography.Text>
      </Space>
    );
  }

  if (
    props.configKey === 'image_generation_credits' ||
    props.configKey === 'media_feature_free_trial_limit' ||
    props.configKey === 'image_width' ||
    props.configKey === 'image_height' ||
    props.configKey === 'image_max_prompt_chars' ||
    props.configKey === 'image_max_output_bytes'
  ) {
    const isDimension = props.configKey === 'image_width' || props.configKey === 'image_height';
    const isBytes = props.configKey === 'image_max_output_bytes';
    const isContractLimit = props.configKey === 'image_max_prompt_chars';
    const isFreeTrialLimit = props.configKey === 'media_feature_free_trial_limit';
    return (
      <InputNumber
        min={isDimension ? 256 : isBytes ? 1048576 : 1}
        max={
          isDimension
            ? 4096
            : isBytes
              ? 52428800
              : isFreeTrialLimit
                ? MAX_FEATURE_FREE_TRIAL_LIMIT
                : isContractLimit
                  ? 1000
                  : undefined
        }
        precision={0}
        value={typeof props.value === 'number' ? props.value : undefined}
        disabled={props.disabled || isContractLimit}
        onChange={(value) => props.onChange(value ?? configMetadata[props.configKey].defaultValue)}
      />
    );
  }

  if (props.configKey === 'system_instructions') {
    return (
      <SystemInstructionsEditor
        value={typeof props.value === 'string' ? props.value : ''}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (
    props.configKey === 'choice_rules' ||
    props.configKey === 'status_rules' ||
    props.configKey === 'memory_rules'
  ) {
    const fallback = configMetadata[props.configKey].defaultValue as InstructionSlotRules;
    const parsed =
      props.value && typeof props.value === 'object' && !Array.isArray(props.value)
        ? (props.value as Partial<InstructionSlotRules>)
        : {};
    return (
      <PlatformInstructionSlotRulesEditor
        value={{
          on_first_two_turns: parsed.on_first_two_turns ?? fallback.on_first_two_turns,
          on_later_turns: parsed.on_later_turns ?? fallback.on_later_turns,
          off: parsed.off ?? fallback.off,
        }}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (props.configKey === 'pref_word_count_tiers') {
    return (
      <WordCountTiersEditor
        value={asWordCountTiersConfig(props.value)}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (props.configKey === 'lobby_pinned_characters') {
    return (
      <LobbyPinnedCharactersEditor
        value={props.value}
        characters={props.characters}
        charactersLoading={props.charactersLoading}
        charactersError={props.charactersError}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (props.configKey === 'lobby_ranking_params') {
    return (
      <LobbyRankingParamsEditor
        value={props.value}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (
    props.configKey === 'miniapp_new_user_signup_bonus_credits' ||
    props.configKey === 'miniapp_daily_checkin_bonus_credits' ||
    props.configKey === 'miniapp_checkin_new_user_credits' ||
    props.configKey === 'miniapp_checkin_veteran_credits' ||
    props.configKey === 'miniapp_character_free_chat_quota_limit'
  ) {
    return (
      <InputNumber
        min={props.configKey === 'miniapp_character_free_chat_quota_limit' ? 1 : 0}
        precision={0}
        value={typeof props.value === 'number' ? props.value : 0}
        disabled={props.disabled}
        onChange={(value) => props.onChange(value ?? 0)}
      />
    );
  }

  if (props.configKey === 'system_fallback_character_id') {
    return (
      <Input
        value={typeof props.value === 'string' ? props.value : ''}
        placeholder="角色 UUID"
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    );
  }

  if (props.configKey === 'miniapp_free_quota_exhausted_dialog_config') {
    const parsed = FreeQuotaExhaustedDialogConfigSchema.safeParse(props.value);
    const value = parsed.success ? parsed.data : DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG;
    return (
      <Space direction="vertical" size="small" className="editor-stack">
        <Input.TextArea
          value={value.text}
          rows={3}
          maxLength={200}
          showCount
          disabled={props.disabled}
          onChange={(event) => props.onChange({ text: event.target.value })}
        />
        <Typography.Text type="secondary">
          使用 {'{characterName}'} 插入当前角色名；展示时最多保留 7 个字。
        </Typography.Text>
      </Space>
    );
  }

  if (props.configKey === 'llm_pricing_config') {
    const parsed = LlmPricingConfigSchema.safeParse(props.value);
    const fixedDeduction = parsed.success
      ? parsed.data.fixedDeduction
      : {
          freeQuotaExhausted: 10,
          light: 15,
          standard: 30,
          premium: 50,
        };
    return (
      <Row gutter={[12, 12]}>
        {(
          [
            ['freeQuotaExhausted', '免费模型超出免费轮次'],
            ['light', '轻量档（付费）'],
            ['standard', '标准档'],
            ['premium', '旗舰档'],
          ] as const
        ).map(([key, label]) => (
          <Col xs={24} md={12} lg={6} key={key}>
            <Typography.Text>{label}（星尘/轮）</Typography.Text>
            <InputNumber
              min={0}
              className="field-full"
              value={fixedDeduction[key]}
              disabled={props.disabled}
              onChange={(number) =>
                props.onChange({
                  fixedDeduction: { ...fixedDeduction, [key]: number ?? 0 },
                })
              }
            />
          </Col>
        ))}
      </Row>
    );
  }

  if (props.configKey === 'miniapp_payment_plans') {
    const paymentConfig = asPaymentPlansConfig(props.value);
    const plans = paymentConfig.plans;
    return (
      <Space direction="vertical" size="middle" className="editor-stack">
        {plans.map((plan, index) => (
          <Card
            key={`${plan.id}-${index}`}
            size="small"
            title={plan.id || `套餐 ${index + 1}`}
            extra={
              <Button
                danger
                size="small"
                disabled={props.disabled}
                onClick={() =>
                  props.onChange({
                    ...paymentConfig,
                    plans: plans.filter((_, itemIndex) => itemIndex !== index),
                  })
                }
              >
                删除
              </Button>
            }
          >
            <Row gutter={[12, 12]}>
              {[
                ['id', '稳定 ID'],
                ['badge_text', '角标'],
                ['sub_copy', '副标题'],
                ['highlight_text', '高亮文案'],
              ].map(([key, label]) => (
                <Col xs={24} md={12} key={key}>
                  <Typography.Text>{label}</Typography.Text>
                  <Input
                    value={(plan[key as keyof PaymentPlan] as string | null) ?? ''}
                    disabled={props.disabled}
                    onChange={(event) => {
                      const next = structuredClone(plans);
                      (next[index] as unknown as Record<string, unknown>)[key] =
                        key === 'id' ? event.target.value : event.target.value || null;
                      props.onChange({ ...paymentConfig, plans: next });
                    }}
                  />
                </Col>
              ))}
              {[
                ['price_cents', '实付价格（分）'],
                ['original_price_cents', '划线原价（分）'],
                ['credits_amount', '主星尘'],
                ['bonus_credits', '赠送星尘'],
              ].map(([key, label]) => (
                <Col xs={12} md={6} key={key}>
                  <Typography.Text>{label}</Typography.Text>
                  <InputNumber
                    min={0}
                    precision={0}
                    className="field-full"
                    value={plan[key as keyof PaymentPlan] as number | null}
                    disabled={props.disabled}
                    onChange={(number) => {
                      const next = structuredClone(plans);
                      (next[index] as unknown as Record<string, unknown>)[key] =
                        key === 'original_price_cents' ? number : (number ?? 0);
                      props.onChange({ ...paymentConfig, plans: next });
                    }}
                  />
                </Col>
              ))}
              <Col xs={24} md={8}>
                <Typography.Text>视觉档位</Typography.Text>
                <Select
                  className="field-full"
                  value={plan.variant}
                  disabled={props.disabled}
                  options={['entry', 'standard', 'recommended', 'premium'].map((value) => ({
                    value,
                    label: value,
                  }))}
                  onChange={(variant) => {
                    const next = structuredClone(plans);
                    next[index].variant = variant;
                    props.onChange({ ...paymentConfig, plans: next });
                  }}
                />
              </Col>
            </Row>
          </Card>
        ))}
        <Button
          block
          disabled={props.disabled}
          onClick={() =>
            props.onChange({
              ...paymentConfig,
              plans: [
                ...plans,
                {
                  id: `plan-${Date.now()}`,
                  price_cents: 0,
                  original_price_cents: null,
                  credits_amount: 0,
                  bonus_credits: 0,
                  variant: 'entry',
                  badge_text: null,
                  sub_copy: null,
                  highlight_text: null,
                } satisfies PaymentPlan,
              ],
            })
          }
        >
          添加充值套餐
        </Button>
        <Card size="small" title="支付通道">
          <Space direction="vertical" size="middle" className="editor-stack">
            <Typography.Text type="secondary">
              仅控制用户端新订单入口；已创建订单与微信支付的服务端处理保持不变。
            </Typography.Text>
            <Space wrap>
              <Switch
                checked={paymentConfig.payment_channels.alipay_enabled}
                disabled={props.disabled}
                checkedChildren="支付宝已开启"
                unCheckedChildren="支付宝已关闭"
                onChange={(alipay_enabled) => {
                  const channels = { ...paymentConfig.payment_channels, alipay_enabled };
                  if (
                    !alipay_enabled &&
                    channels.default_payment_type === 'alipay' &&
                    channels.wxpay_enabled
                  ) {
                    channels.default_payment_type = 'wxpay';
                  }
                  props.onChange({ ...paymentConfig, payment_channels: channels });
                }}
              />
              <Switch
                checked={paymentConfig.payment_channels.wxpay_enabled}
                disabled={props.disabled}
                checkedChildren="微信已开启"
                unCheckedChildren="微信已关闭"
                onChange={(wxpay_enabled) => {
                  const channels = { ...paymentConfig.payment_channels, wxpay_enabled };
                  if (
                    !wxpay_enabled &&
                    channels.default_payment_type === 'wxpay' &&
                    channels.alipay_enabled
                  ) {
                    channels.default_payment_type = 'alipay';
                  }
                  props.onChange({ ...paymentConfig, payment_channels: channels });
                }}
              />
            </Space>
            <div>
              <Typography.Text>默认支付通道</Typography.Text>
              <Select
                className="field-full"
                value={paymentConfig.payment_channels.default_payment_type}
                disabled={props.disabled}
                options={[
                  {
                    value: 'alipay',
                    label: '支付宝',
                    disabled: !paymentConfig.payment_channels.alipay_enabled,
                  },
                  {
                    value: 'wxpay',
                    label: '微信支付',
                    disabled: !paymentConfig.payment_channels.wxpay_enabled,
                  },
                ]}
                onChange={(default_payment_type) =>
                  props.onChange({
                    ...paymentConfig,
                    payment_channels: {
                      ...paymentConfig.payment_channels,
                      default_payment_type,
                    },
                  })
                }
              />
            </div>
          </Space>
        </Card>
      </Space>
    );
  }

  if (props.configKey === 'miniapp_recharge_page_config') {
    const parsed = RechargePageConfigSchema.safeParse(props.value);
    return (
      <RechargePageConfigEditor
        value={parsed.success ? parsed.data : DEFAULT_RECHARGE_PAGE_CONFIG}
        plans={props.paymentPlans}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (props.configKey === 'llm_provider_routing_config') {
    return (
      <ProviderRoutingConfigEditor
        value={props.value}
        disabled={props.disabled}
        onChange={props.onChange}
        openRouterDirectory={openRouterDirectory}
      />
    );
  }

  if (props.configKey === 'miniapp_payment_prompt_dialog_config') {
    const parsed = PaymentPromptDialogConfigSchema.safeParse(props.value);
    return (
      <PaymentPromptDialogConfigEditor
        value={parsed.success ? parsed.data : DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (props.configKey === 'miniapp_invite_reward_rules') {
    return (
      <InviteRewardRulesEditor
        value={asInviteRewardRules(props.value)}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (props.configKey === 'miniapp_invite_center_config') {
    return (
      <InviteCenterConfigEditor
        value={asInviteCenterConfig(props.value)}
        disabled={props.disabled}
        onChange={props.onChange}
        onUploadPoster={props.onUploadInvitePoster}
      />
    );
  }

  if (props.configKey === 'miniapp_invite_entry_enabled') {
    const enabled = props.value === true;
    return (
      <Space align="center" size="middle">
        <Switch
          checked={enabled}
          disabled={props.disabled}
          onChange={(next) => props.onChange(next)}
        />
        <div>
          <Typography.Text strong>{enabled ? '入口已开启' : '入口已关闭'}</Typography.Text>
          <br />
          <Typography.Text type="secondary">
            关闭时 C 端「我的」页卡片、充值页快捷入口与星尘不足弹窗按钮全部隐藏。发布后生效。
          </Typography.Text>
        </div>
      </Space>
    );
  }

  const parsedCatalog = ModelCatalogSchema.safeParse(props.value);
  const editableCatalog = EditableModelCatalogSchema.safeParse(props.value);
  const modelCatalog = editableCatalog.success
    ? (editableCatalog.data as ModelCatalog)
    : (structuredClone(configMetadata.llm_model_catalog.defaultValue) as ModelCatalog);

  return (
    <Space direction="vertical" className="editor-stack">
      {!editableCatalog.success ? (
        <Alert type="warning" showIcon message="模型目录结构无效或尚未初始化，已载入安全默认值。" />
      ) : !parsedCatalog.success ? (
        <Alert
          type="info"
          showIcon
          message="当前模型目录尚未填写完整；内容会保留在页面，补全必填项后自动保存草稿。"
        />
      ) : null}
      {props.modelCatalogSection === 'fallback' ? (
        <FallbackConfigEditor
          value={modelCatalog}
          onChange={props.onChange}
          disabled={props.disabled}
          directory={props.providerDirectories.openrouter}
          loading={props.syncLoading.openrouter}
          error={props.syncError.openrouter}
          onRefresh={() => props.onRefreshProvider('openrouter')}
        />
      ) : (
        <ModelCatalogEditor
          value={modelCatalog}
          onChange={props.onChange}
          disabled={props.disabled}
          providerDirectories={props.providerDirectories}
          publishedModelIds={props.publishedModelIds}
          syncLoading={props.syncLoading}
          syncError={props.syncError}
          onRefreshProvider={props.onRefreshProvider}
        />
      )}
    </Space>
  );
}
