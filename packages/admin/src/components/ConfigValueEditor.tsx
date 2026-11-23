import { ReplyStyleOptionsEditor } from './ReplyStyleOptionsEditor';
import { DriveModeOptionsEditor } from './DriveModeOptionsEditor';
import { memoryConfigEditor } from './StoryMemoryEditors';
import { LlmPricingConfigEditor } from './LlmPricingConfigEditor';
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
  CREATOR_REVIEW_PROMPT_KEY,
  DRIVE_MODE_OPTIONS_KEY,
  FREE_ZONE_CONFIG_KEY,
  DEFAULT_PAYMENT_CHANNELS_CONFIG,
  DEFAULT_WORD_COUNT_TIERS_CONFIG,
  IMAGE_PLAZA_DEFAULT_TAG_GROUP_ID,
  IMAGE_PLAZA_DEFAULT_TAG_GROUP_LABEL,
  ImagePlazaModelCatalogSchema,
  ImagePlazaShareTipConfigSchema,
  ImagePlazaTagConfigSchema,
  VideoPlazaModelCatalogSchema,
  LlmPricingConfigSchema,
  ModelCatalogSchema,
  type ModelCatalog,
  type LlmModelProvider,
  type OpenRouterModelDirectory,
  type PaymentPlan,
  type PaymentPlansConfig,
  type ProviderModelDirectory,
  type WordCountTiersConfig,
  type InstructionSlotRules,
  type CreatorReviewTestRequest,
  type CreatorReviewTestData,
} from '@miniapp/shared';
import {
  configMetadata,
  DEFAULT_INVITE_CENTER_CONFIG,
  DEFAULT_INVITE_REWARD_RULES,
  EditableModelCatalogSchema,
  EditableReplyStyleOptionsConfigSchema,
  EditableImagePlazaTagConfigSchema,
  normalizeVideoPlazaCatalogOptions,
  type InviteCenterConfig,
  type InviteRewardRulesConfig,
  type ManagedConfigKey,
} from '@miniapp/admin-client';
import { InviteCenterConfigEditor } from './InviteCenterConfigEditor';
import { InviteRewardRulesEditor } from './InviteRewardRulesEditor';
import {
  ImagePlazaModelCatalogEditor,
  ImagePlazaShareTipEditor,
  ImagePlazaTagsEditor,
  VideoPlazaModelCatalogEditor,
} from './ImagePlazaConfigEditors';
import { LobbyRankingParamsEditor } from './LobbyRankingParamsEditor';
import { ModelCatalogEditor } from './ModelCatalogEditor';
import { FallbackConfigEditor } from './FallbackConfigEditor';
import { FreeZoneConfigEditor } from './FreeZoneConfigEditor';
import { ProviderRoutingConfigEditor } from './ProviderRoutingConfigEditor';
import { SystemInstructionsEditor } from './SystemInstructionsEditor';
import { CreatorReviewPromptEditor } from './CreatorReviewPromptEditor';
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
  onUploadInvitePoster: (file: File) => Promise<string>;
  onTestCreatorReview: (
    input: CreatorReviewTestRequest,
    signal?: AbortSignal
  ) => Promise<CreatorReviewTestData>;
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

  if (props.configKey === 'image_plaza_video_model_catalog') {
    const parsed = VideoPlazaModelCatalogSchema.safeParse(props.value);
    const fallback = VideoPlazaModelCatalogSchema.parse(
      configMetadata.image_plaza_video_model_catalog.defaultValue
    );
    const value = normalizeVideoPlazaCatalogOptions(parsed.success ? parsed.data : fallback);
    return (
      <VideoPlazaModelCatalogEditor
        value={value}
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

  if (props.configKey === 'image_plaza_tags') {
    const parsed = EditableImagePlazaTagConfigSchema.safeParse(props.value);
    const fallback = ImagePlazaTagConfigSchema.parse(configMetadata.image_plaza_tags.defaultValue);
    const value = parsed.success
      ? parsed.data.map((tag) => ({
          ...tag,
          group_id: tag.group_id ?? IMAGE_PLAZA_DEFAULT_TAG_GROUP_ID,
          group_label: tag.group_label ?? IMAGE_PLAZA_DEFAULT_TAG_GROUP_LABEL,
          group_sort_order: tag.group_sort_order ?? 0,
          group_layout: tag.group_layout ?? ('chips' as const),
        }))
      : fallback;
    return (
      <ImagePlazaTagsEditor value={value} disabled={props.disabled} onChange={props.onChange} />
    );
  }

  if (props.configKey === 'reply_style_options') {
    const editable = EditableReplyStyleOptionsConfigSchema.safeParse(props.value);
    if (!editable.success) {
      return (
        <Alert type="error" showIcon message="回复风格配置格式有误，请撤销编辑或回滚到有效版本。" />
      );
    }
    return (
      <ReplyStyleOptionsEditor
        value={editable.data}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (props.configKey === CREATOR_REVIEW_PROMPT_KEY) {
    return (
      <CreatorReviewPromptEditor
        value={typeof props.value === 'string' ? props.value : ''}
        disabled={props.disabled}
        onChange={props.onChange}
        onTest={props.onTestCreatorReview}
      />
    );
  }

  if (props.configKey === FREE_ZONE_CONFIG_KEY) return <FreeZoneConfigEditor {...props} />;
  if (props.configKey === DRIVE_MODE_OPTIONS_KEY) return <DriveModeOptionsEditor {...props} />;

  const memoryEditor = memoryConfigEditor(props);
  if (memoryEditor) return memoryEditor;

  if (props.configKey === 'system_instructions') {
    return (
      <SystemInstructionsEditor
        value={typeof props.value === 'string' ? props.value : ''}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }

  if (props.configKey === 'choice_rules') {
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
    props.configKey === 'miniapp_checkin_new_user_credits' ||
    props.configKey === 'miniapp_checkin_veteran_credits'
  ) {
    return (
      <InputNumber
        min={0}
        precision={0}
        value={typeof props.value === 'number' ? props.value : 0}
        disabled={props.disabled}
        onChange={(value) => props.onChange(value ?? 0)}
      />
    );
  }

  if (props.configKey === 'llm_pricing_config') {
    return (
      <LlmPricingConfigEditor
        value={props.value}
        disabled={props.disabled}
        onChange={props.onChange}
      />
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
