import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import type {
  DisplayPricingConfig,
  ModelCatalog,
  ModelCatalogModel,
  ModelCatalogTier,
  ModelCatalogTierKey,
  OpenRouterModelDirectory,
} from '@miniapp/shared';
import { calculateModelDisplayPrices } from '../lib/openRouterModels';

const tierOptions: Array<{ value: ModelCatalogTierKey; label: string; color: string }> = [
  { value: 'light', label: '轻量', color: '#4ade80' },
  { value: 'standard', label: '标准', color: '#818cf8' },
  { value: 'premium', label: '旗舰', color: '#c084fc' },
];

function copyCatalog(value: ModelCatalog): ModelCatalog {
  return structuredClone(value);
}

function newModel(index: number): ModelCatalogModel {
  return {
    id: `model-${Date.now()}-${index}`,
    openrouter_model_id: '',
    display_name: '新模型',
    tagline: '',
    price_input: 0,
    price_output: 0,
    enabled: true,
    sort_order: index + 1,
  };
}

export function ModelCatalogEditor(props: {
  value: ModelCatalog;
  onChange: (value: ModelCatalog) => void;
  disabled?: boolean;
  openRouterDirectory: OpenRouterModelDirectory | null;
  pricingConfig: DisplayPricingConfig;
  publishedModelIds: ReadonlySet<string>;
  syncLoading: boolean;
  syncError: string | null;
  onRefreshOpenRouter: () => void;
}) {
  const updateTier = (tierIndex: number, patch: Partial<ModelCatalogTier>) => {
    const next = copyCatalog(props.value);
    next.tiers[tierIndex] = { ...next.tiers[tierIndex], ...patch };
    props.onChange(next);
  };

  const updateModel = (
    tierIndex: number,
    modelIndex: number,
    patch: Partial<ModelCatalogModel>
  ) => {
    const next = copyCatalog(props.value);
    next.tiers[tierIndex].models[modelIndex] = {
      ...next.tiers[tierIndex].models[modelIndex],
      ...patch,
    };
    props.onChange(next);
  };

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Card size="small">
        <Space direction="vertical" className="field-full">
          <Space wrap>
            <Typography.Text strong>OpenRouter 模型目录</Typography.Text>
            {props.openRouterDirectory ? (
              <Tag color={props.openRouterDirectory.stale ? 'orange' : 'green'}>
                {props.openRouterDirectory.stale ? '使用缓存' : '已同步'} ·{' '}
                {props.openRouterDirectory.models.length} 个模型
              </Tag>
            ) : (
              <Tag>未同步</Tag>
            )}
            <Button size="small" loading={props.syncLoading} onClick={props.onRefreshOpenRouter}>
              重新同步
            </Button>
          </Space>
          {props.syncError ? <Alert type="error" showIcon message={props.syncError} /> : null}
          {props.openRouterDirectory ? (
            <Typography.Text type="secondary">
              上游更新时间：
              {new Date(props.openRouterDirectory.fetched_at).toLocaleString('zh-CN', {
                hour12: false,
              })}
              。选择模型后，将使用当前汇率与加价倍率自动换算展示价格。
            </Typography.Text>
          ) : null}
        </Space>
      </Card>
      <Card size="small">
        <Space direction="vertical" className="field-full">
          <Typography.Text strong>默认模型</Typography.Text>
          <Select
            value={props.value.default_model_id}
            disabled={props.disabled}
            options={props.value.tiers.flatMap((tier) =>
              tier.models.map((model) => ({
                value: model.id,
                label: `${model.display_name}（${model.id}）`,
              }))
            )}
            onChange={(default_model_id) => props.onChange({ ...props.value, default_model_id })}
          />
        </Space>
      </Card>

      <Collapse
        defaultActiveKey={props.value.tiers.map((tier) => tier.tier)}
        items={props.value.tiers.map((tier, tierIndex) => ({
          key: tier.tier,
          label: `${tier.label} · ${tier.models.length} 个模型`,
          children: (
            <Space direction="vertical" size="middle" className="editor-stack">
              <Row gutter={[12, 12]}>
                <Col xs={24} md={6}>
                  <Typography.Text>档位</Typography.Text>
                  <Select
                    className="field-full"
                    value={tier.tier}
                    options={tierOptions}
                    disabled={props.disabled}
                    onChange={(value) => {
                      const option = tierOptions.find((item) => item.value === value);
                      updateTier(tierIndex, {
                        tier: value,
                        label: option?.label ?? tier.label,
                        color: option?.color ?? tier.color,
                      });
                    }}
                  />
                </Col>
                <Col xs={24} md={6}>
                  <Typography.Text>显示名称</Typography.Text>
                  <Input
                    value={tier.label}
                    disabled={props.disabled}
                    onChange={(event) => updateTier(tierIndex, { label: event.target.value })}
                  />
                </Col>
                <Col xs={24} md={6}>
                  <Typography.Text>主题色</Typography.Text>
                  <Input
                    value={tier.color}
                    disabled={props.disabled}
                    onChange={(event) => updateTier(tierIndex, { color: event.target.value })}
                  />
                </Col>
                <Col xs={24} md={6}>
                  <Typography.Text>排序</Typography.Text>
                  <InputNumber
                    className="field-full"
                    value={tier.sort_order}
                    disabled={props.disabled}
                    onChange={(value) => updateTier(tierIndex, { sort_order: value ?? 0 })}
                  />
                </Col>
                <Col span={24}>
                  <Typography.Text>参考消耗文案</Typography.Text>
                  <Input
                    value={tier.cost_hint}
                    disabled={props.disabled}
                    onChange={(event) => updateTier(tierIndex, { cost_hint: event.target.value })}
                  />
                </Col>
              </Row>

              {tier.models.map((model, modelIndex) => (
                <Card
                  key={`${tier.tier}-${modelIndex}`}
                  size="small"
                  title={
                    <Space>
                      <Radio
                        checked={props.value.default_model_id === model.id}
                        disabled={props.disabled}
                        onChange={() =>
                          props.onChange({ ...props.value, default_model_id: model.id })
                        }
                      />
                      <span>{model.display_name || '未命名模型'}</span>
                    </Space>
                  }
                  extra={
                    <Popconfirm
                      title="确定删除这个模型？"
                      disabled={props.disabled}
                      onConfirm={() => {
                        const next = copyCatalog(props.value);
                        next.tiers[tierIndex].models.splice(modelIndex, 1);
                        if (next.default_model_id === model.id) {
                          next.default_model_id =
                            next.tiers.flatMap((item) => item.models)[0]?.id ?? '';
                        }
                        props.onChange(next);
                      }}
                    >
                      <Button danger size="small" disabled={props.disabled}>
                        删除
                      </Button>
                    </Popconfirm>
                  }
                >
                  <Row gutter={[12, 12]}>
                    <Col xs={24} md={8}>
                      <Typography.Text>内部稳定 ID</Typography.Text>
                      <Input
                        value={model.id}
                        disabled={props.disabled || props.publishedModelIds.has(model.id)}
                        onChange={(event) => {
                          const oldId = model.id;
                          const id = event.target.value;
                          updateModel(tierIndex, modelIndex, { id });
                          if (props.value.default_model_id === oldId) {
                            props.onChange({
                              ...copyCatalog(props.value),
                              default_model_id: id,
                              tiers: copyCatalog(props.value).tiers.map((item, i) => ({
                                ...item,
                                models: item.models.map((entry, j) =>
                                  i === tierIndex && j === modelIndex ? { ...entry, id } : entry
                                ),
                              })),
                            });
                          }
                        }}
                      />
                    </Col>
                    <Col xs={24} md={8}>
                      <Typography.Text>OpenRouter 模型 ID</Typography.Text>
                      <Select
                        className="field-full"
                        value={model.openrouter_model_id}
                        showSearch
                        optionFilterProp="label"
                        options={(props.openRouterDirectory?.models ?? []).map((item) => ({
                          value: item.id,
                          label: `${item.name}（${item.id}）`,
                        }))}
                        placeholder="例如 deepseek/deepseek-v3.2"
                        disabled={props.disabled || !props.openRouterDirectory}
                        onChange={(openrouter_model_id) => {
                          const upstream = props.openRouterDirectory?.models.find(
                            (item) => item.id === openrouter_model_id
                          );
                          if (!upstream) return;

                          updateModel(tierIndex, modelIndex, {
                            openrouter_model_id,
                            display_name: upstream.name,
                            ...calculateModelDisplayPrices(upstream, props.pricingConfig),
                          });
                        }}
                      />
                    </Col>
                    <Col xs={24} md={8}>
                      <Typography.Text>展示名称</Typography.Text>
                      <Input
                        value={model.display_name}
                        disabled={props.disabled}
                        onChange={(event) =>
                          updateModel(tierIndex, modelIndex, {
                            display_name: event.target.value,
                          })
                        }
                      />
                    </Col>
                    <Col xs={24} md={8}>
                      <Typography.Text>特点文案（最多 15 字）</Typography.Text>
                      <Input
                        value={model.tagline}
                        maxLength={15}
                        showCount
                        disabled={props.disabled}
                        onChange={(event) =>
                          updateModel(tierIndex, modelIndex, { tagline: event.target.value })
                        }
                      />
                    </Col>
                    <Col xs={12} md={4}>
                      <Typography.Text>输入展示价</Typography.Text>
                      <InputNumber
                        min={0}
                        className="field-full"
                        value={model.price_input}
                        disabled={props.disabled}
                        onChange={(value) =>
                          updateModel(tierIndex, modelIndex, { price_input: value ?? 0 })
                        }
                      />
                    </Col>
                    <Col xs={12} md={4}>
                      <Typography.Text>输出展示价</Typography.Text>
                      <InputNumber
                        min={0}
                        className="field-full"
                        value={model.price_output}
                        disabled={props.disabled}
                        onChange={(value) =>
                          updateModel(tierIndex, modelIndex, { price_output: value ?? 0 })
                        }
                      />
                    </Col>
                    <Col xs={12} md={4}>
                      <Typography.Text>排序</Typography.Text>
                      <InputNumber
                        className="field-full"
                        value={model.sort_order}
                        disabled={props.disabled}
                        onChange={(value) =>
                          updateModel(tierIndex, modelIndex, { sort_order: value ?? 0 })
                        }
                      />
                    </Col>
                    <Col xs={12} md={4}>
                      <Typography.Text>上架</Typography.Text>
                      <div>
                        <Switch
                          checked={model.enabled}
                          disabled={props.disabled}
                          onChange={(enabled) => updateModel(tierIndex, modelIndex, { enabled })}
                        />
                      </div>
                    </Col>
                  </Row>
                </Card>
              ))}

              <Button
                block
                disabled={props.disabled}
                onClick={() => {
                  const next = copyCatalog(props.value);
                  const model = newModel(next.tiers[tierIndex].models.length);
                  next.tiers[tierIndex].models.push(model);
                  if (!next.default_model_id) next.default_model_id = model.id;
                  props.onChange(next);
                }}
              >
                添加模型
              </Button>
            </Space>
          ),
        }))}
      />

      <Button
        disabled={props.disabled || props.value.tiers.length >= tierOptions.length}
        onClick={() => {
          const used = new Set(props.value.tiers.map((tier) => tier.tier));
          const option = tierOptions.find((item) => !used.has(item.value));
          if (!option) return;
          props.onChange({
            ...props.value,
            tiers: [
              ...props.value.tiers,
              {
                tier: option.value,
                label: option.label,
                color: option.color,
                cost_hint: '',
                sort_order: props.value.tiers.length + 1,
                models: [],
              },
            ],
          });
        }}
      >
        添加档位
      </Button>
    </Space>
  );
}
