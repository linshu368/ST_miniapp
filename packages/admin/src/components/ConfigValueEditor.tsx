import { Alert, Button, Card, Col, Input, InputNumber, Row, Select, Space, Typography } from 'antd';
import {
  ModelCatalogSchema,
  type DisplayPricingConfig,
  type ModelCatalog,
  type OpenRouterModelDirectory,
  type PaymentPlan,
} from '@miniapp/shared';
import {
  configMetadata,
  EditableModelCatalogSchema,
  type ManagedConfigKey,
} from '../lib/configSchemas';
import { ModelCatalogEditor } from './ModelCatalogEditor';

export function ConfigValueEditor(props: {
  configKey: ManagedConfigKey;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  openRouterDirectory: OpenRouterModelDirectory | null;
  pricingConfig: DisplayPricingConfig;
  publishedModelIds: ReadonlySet<string>;
  syncLoading: boolean;
  syncError: string | null;
  onRefreshOpenRouter: () => void;
}) {
  if (
    props.configKey === 'miniapp_new_user_signup_bonus_credits' ||
    props.configKey === 'miniapp_daily_checkin_bonus_credits'
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

  if (props.configKey === 'llm_pricing_config') {
    const value = (props.value ?? {}) as Record<string, number>;
    return (
      <Row gutter={[12, 12]}>
        {[
          ['balanceBaseline', '余额预检基准'],
          ['fallbackCost', '元数据失败兜底星尘'],
          ['exchangeRate', '美元兑星尘汇率'],
          ['markup', '加价倍率'],
        ].map(([key, label]) => (
          <Col xs={24} md={12} key={key}>
            <Typography.Text>{label}</Typography.Text>
            <InputNumber
              min={0}
              className="field-full"
              value={value[key]}
              disabled={props.disabled}
              onChange={(number) => props.onChange({ ...value, [key]: number ?? 0 })}
            />
          </Col>
        ))}
        <Col span={24}>
          <Typography.Text type="warning">
            这里控制真实动态扣费换算；模型目录中的输入/输出价格仅用于展示。
          </Typography.Text>
        </Col>
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
        pricingConfig={props.pricingConfig}
        publishedModelIds={props.publishedModelIds}
        syncLoading={props.syncLoading}
        syncError={props.syncError}
        onRefreshOpenRouter={props.onRefreshOpenRouter}
      />
    </Space>
  );
}
