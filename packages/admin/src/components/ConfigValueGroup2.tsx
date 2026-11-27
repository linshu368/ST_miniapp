import {
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
  type OpenRouterModelDirectory,
  type PaymentPlan,
  type PaymentPlansConfig,
} from '@miniapp/shared';

import { InviteRewardRulesEditor } from './InviteRewardRulesEditor';

import { ProviderRoutingConfigEditor } from './ProviderRoutingConfigEditor';

import type { ConfigValueEditorProps } from './config-value-types';
import { asInviteRewardRules, asPaymentPlansConfig } from './config-value-helpers';

export function renderConfigGroup2(props: ConfigValueEditorProps) {
  const result17 = renderBranch17(props);
  if (result17 !== null) return result17;
  const result18 = renderBranch18(props);
  if (result18 !== null) return result18;
  const result19 = renderBranch19(props);
  if (result19 !== null) return result19;
  return null;
}

function renderBranch17(props: ConfigValueEditorProps) {
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
        <AddPaymentPlanButton {...props} paymentConfig={paymentConfig} />
        <PaymentChannelsEditor {...props} paymentConfig={paymentConfig} />
      </Space>
    );
  }
  return null;
}

function renderBranch18(props: ConfigValueEditorProps) {
  const openRouterDirectory: OpenRouterModelDirectory | null = props.providerDirectories.openrouter
    ? {
        models: props.providerDirectories.openrouter.models.flatMap((model) =>
          model.prompt_usd_per_token === null || model.completion_usd_per_token === null
            ? []
            : [
                {
                  id: model.id,
                  canonical_slug: null,
                  name: model.name,
                  description: model.description,
                  context_length: model.context_length,
                  prompt_usd_per_token: model.prompt_usd_per_token,
                  completion_usd_per_token: model.completion_usd_per_token,
                  expiration_date: null,
                },
              ]
        ),
        fetched_at: props.providerDirectories.openrouter.fetched_at,
        stale: props.providerDirectories.openrouter.stale,
      }
    : null;
  if (props.configKey === 'llm_provider_routing_config') {
    return (
      <ProviderRoutingConfigEditor
        value={props.value}
        disabled={props.disabled}
        onChange={props.onChange}
        openRouterDirectory={openRouterDirectory}
        surplusDirectory={props.providerDirectories.surplus ?? null}
      />
    );
  }
  return null;
}

function renderBranch19(props: ConfigValueEditorProps) {
  if (props.configKey === 'miniapp_invite_reward_rules') {
    return (
      <InviteRewardRulesEditor
        value={asInviteRewardRules(props.value)}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  return null;
}

function PaymentChannelsEditor(
  props: ConfigValueEditorProps & { paymentConfig: PaymentPlansConfig }
) {
  const { paymentConfig } = props;
  return (
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
  );
}

function AddPaymentPlanButton(
  props: ConfigValueEditorProps & { paymentConfig: PaymentPlansConfig }
) {
  const { paymentConfig } = props;
  const plans = paymentConfig.plans;
  return (
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
  );
}
