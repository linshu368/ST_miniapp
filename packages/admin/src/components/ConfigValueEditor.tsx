import {
  Alert,
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
  DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  DEFAULT_RECHARGE_PAGE_CONFIG,
  DEFAULT_WORD_COUNT_TIERS_CONFIG,
  FreeQuotaExhaustedDialogConfigSchema,
  LlmPricingConfigSchema,
  ModelCatalogSchema,
  PaymentPromptDialogConfigSchema,
  RechargePageConfigSchema,
  type ModelCatalog,
  type OpenRouterModelDirectory,
  type PaymentPlan,
  type WordCountTiersConfig,
} from '@miniapp/shared';
import {
  configMetadata,
  DEFAULT_INVITE_CENTER_CONFIG,
  DEFAULT_INVITE_REWARD_RULES,
  EditableModelCatalogSchema,
  type InviteCenterConfig,
  type InviteRewardRulesConfig,
  type ManagedConfigKey,
} from '../lib/configSchemas';
import type { CharacterCard } from '../lib/adminApi';
import { InviteCenterConfigEditor } from './InviteCenterConfigEditor';
import { InviteRewardRulesEditor } from './InviteRewardRulesEditor';
import { LobbyPinnedCharactersEditor } from './LobbyPinnedCharactersEditor';
import { LobbyRankingParamsEditor } from './LobbyRankingParamsEditor';
import { ModelCatalogEditor } from './ModelCatalogEditor';
import { PaymentPromptDialogConfigEditor } from './PaymentPromptDialogConfigEditor';
import { RechargePageConfigEditor } from './RechargePageConfigEditor';
import { SystemInstructionsEditor } from './SystemInstructionsEditor';
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

export function ConfigValueEditor(props: {
  configKey: ManagedConfigKey;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  openRouterDirectory: OpenRouterModelDirectory | null;
  publishedModelIds: ReadonlySet<string>;
  syncLoading: boolean;
  syncError: string | null;
  onRefreshOpenRouter: () => void;
  paymentPlans: PaymentPlan[];
  characters: CharacterCard[];
  charactersLoading: boolean;
  charactersError: string | null;
}) {
  if (props.configKey === 'system_instructions') {
    return (
      <SystemInstructionsEditor
        value={typeof props.value === 'string' ? props.value : ''}
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
    const plans = Array.isArray(props.value) ? (props.value as PaymentPlan[]) : [];
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
                onClick={() => props.onChange(plans.filter((_, itemIndex) => itemIndex !== index))}
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
                      props.onChange(next);
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
                      props.onChange(next);
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
                    props.onChange(next);
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
            props.onChange([
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
            ])
          }
        >
          添加充值套餐
        </Button>
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
      <ModelCatalogEditor
        value={modelCatalog}
        onChange={props.onChange}
        disabled={props.disabled}
        openRouterDirectory={props.openRouterDirectory}
        publishedModelIds={props.publishedModelIds}
        syncLoading={props.syncLoading}
        syncError={props.syncError}
        onRefreshOpenRouter={props.onRefreshOpenRouter}
      />
    </Space>
  );
}
