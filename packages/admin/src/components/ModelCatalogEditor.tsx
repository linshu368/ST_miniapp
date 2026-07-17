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
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ReactNode } from 'react';
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

function SortableHandleItem(props: {
  id: string;
  disabled?: boolean;
  children: ReactNode;
  compact?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: props.disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'relative',
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 5 : undefined,
        opacity: isDragging ? 0.72 : 1,
      }}
    >
      <button
        type="button"
        aria-label="拖拽排序"
        disabled={props.disabled}
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
        style={{
          position: 'absolute',
          top: props.compact ? 7 : 9,
          right: props.compact ? 8 : 72,
          zIndex: 2,
          border: 0,
          background: 'transparent',
          color: 'rgba(0,0,0,0.42)',
          cursor: props.disabled ? 'default' : 'grab',
          fontSize: 20,
          lineHeight: 1,
          touchAction: 'none',
        }}
      >
        ⠿
      </button>
      {props.children}
    </div>
  );
}

export function normalizeCatalogSortOrder(catalog: ModelCatalog): ModelCatalog {
  return {
    ...catalog,
    tiers: catalog.tiers.map((tier, tierIndex) => ({
      ...tier,
      sort_order: tierIndex,
      models: tier.models.map((model, modelIndex) => ({
        ...model,
        sort_order: modelIndex,
      })),
    })),
  };
}

export function reorderCatalog(
  catalog: ModelCatalog,
  activeId: string,
  overId: string
): ModelCatalog {
  if (!overId || activeId === overId) return catalog;
  const next = copyCatalog(catalog);

  if (activeId.startsWith('tier:') && overId.startsWith('tier:')) {
    const oldIndex = next.tiers.findIndex((tier) => tier.tier === activeId.slice(5));
    const newIndex = next.tiers.findIndex((tier) => tier.tier === overId.slice(5));
    if (oldIndex < 0 || newIndex < 0) return catalog;
    next.tiers = arrayMove(next.tiers, oldIndex, newIndex);
    return normalizeCatalogSortOrder(next);
  }

  if (activeId.startsWith('model:') && overId.startsWith('model:')) {
    const activeModelId = activeId.slice(6);
    const overModelId = overId.slice(6);
    const sourceTier = next.tiers.find((tier) =>
      tier.models.some((model) => model.id === activeModelId)
    );
    const targetTier = next.tiers.find((tier) =>
      tier.models.some((model) => model.id === overModelId)
    );
    if (!sourceTier || !targetTier) return catalog;
    if (sourceTier.tier !== targetTier.tier) return catalog;
    const sourceIndex = sourceTier.models.findIndex((model) => model.id === activeModelId);
    const targetIndex = targetTier.models.findIndex((model) => model.id === overModelId);
    const [moved] = sourceTier.models.splice(sourceIndex, 1);
    if (!moved) return catalog;
    targetTier.models.splice(targetIndex, 0, moved);
    return normalizeCatalogSortOrder(next);
  }

  return catalog;
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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

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

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : '';
    const reordered = reorderCatalog(props.value, activeId, overId);
    if (reordered !== props.value) props.onChange(reordered);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
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

        <SortableContext
          items={props.value.tiers.map((tier) => `tier:${tier.tier}`)}
          strategy={verticalListSortingStrategy}
        >
          <Collapse
            defaultActiveKey={props.value.tiers.map((tier) => tier.tier)}
            items={props.value.tiers.map((tier, tierIndex) => ({
              key: tier.tier,
              label: (
                <SortableHandleItem id={`tier:${tier.tier}`} disabled={props.disabled} compact>
                  <span>
                    {tier.label} · {tier.models.length} 个模型
                  </span>
                </SortableHandleItem>
              ),
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
                        maxLength={20}
                        showCount
                        disabled={props.disabled}
                        onChange={(event) => updateTier(tierIndex, { label: event.target.value })}
                      />
                    </Col>
                    <Col xs={24} md={6}>
                      <Typography.Text>主题色</Typography.Text>
                      <Input
                        value={tier.color}
                        disabled={props.disabled}
                        maxLength={7}
                        status={/^#[0-9a-fA-F]{6}$/.test(tier.color) ? undefined : 'error'}
                        onChange={(event) => updateTier(tierIndex, { color: event.target.value })}
                      />
                    </Col>
                    <Col xs={24} md={6}>
                      <Typography.Text>排序</Typography.Text>
                      <InputNumber className="field-full" value={tier.sort_order} disabled />
                    </Col>
                    <Col span={24}>
                      <Typography.Text>参考消耗文案</Typography.Text>
                      <Input
                        value={tier.cost_hint}
                        maxLength={30}
                        showCount
                        disabled={props.disabled}
                        onChange={(event) =>
                          updateTier(tierIndex, { cost_hint: event.target.value })
                        }
                      />
                    </Col>
                  </Row>

                  <SortableContext
                    items={tier.models.map((model) => `model:${model.id}`)}
                    strategy={verticalListSortingStrategy}
                  >
                    <Space direction="vertical" size="middle" className="editor-stack">
                      {tier.models.map((model, modelIndex) => (
                        <SortableHandleItem
                          key={`${tier.tier}-${model.id}`}
                          id={`model:${model.id}`}
                          disabled={props.disabled}
                        >
                          <Card
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
                                  maxLength={64}
                                  status={
                                    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(model.id)
                                      ? undefined
                                      : 'error'
                                  }
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
                                            i === tierIndex && j === modelIndex
                                              ? { ...entry, id }
                                              : entry
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
                                  options={(props.openRouterDirectory?.models ?? []).map(
                                    (item) => ({
                                      value: item.id,
                                      label: `${item.name}（${item.id}）`,
                                    })
                                  )}
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
                                  maxLength={40}
                                  showCount
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
                                    updateModel(tierIndex, modelIndex, {
                                      tagline: event.target.value,
                                    })
                                  }
                                />
                              </Col>
                              <Col xs={12} md={4}>
                                <Typography.Text>输入展示价</Typography.Text>
                                <InputNumber
                                  min={0}
                                  precision={1}
                                  step={0.1}
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
                                  precision={1}
                                  step={0.1}
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
                                  disabled
                                />
                              </Col>
                              <Col xs={12} md={4}>
                                <Typography.Text>上架</Typography.Text>
                                <div>
                                  <Switch
                                    checked={model.enabled}
                                    disabled={props.disabled}
                                    onChange={(enabled) =>
                                      updateModel(tierIndex, modelIndex, { enabled })
                                    }
                                  />
                                </div>
                              </Col>
                            </Row>
                          </Card>
                        </SortableHandleItem>
                      ))}
                    </Space>
                  </SortableContext>

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
        </SortableContext>

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
        <ModelCatalogPhonePreview catalog={normalizeCatalogSortOrder(props.value)} />
      </Space>
    </DndContext>
  );
}

function ModelCatalogPhonePreview(props: { catalog: ModelCatalog }) {
  const enabledTiers = props.catalog.tiers
    .map((tier) => ({ ...tier, models: tier.models.filter((model) => model.enabled) }))
    .filter((tier) => tier.models.length > 0);

  return (
    <Card size="small" title="MiniApp 手机预览（当前草稿）">
      <div className="model-phone-preview">
        <div className="model-phone-speaker" />
        <Typography.Title level={5} style={{ color: '#fff', margin: '10px 0 2px' }}>
          选择剧情引擎
        </Typography.Title>
        <Typography.Text style={{ color: 'rgba(255,255,255,.42)', fontSize: 11 }}>
          价格单位：星尘 / 万 token
        </Typography.Text>
        <div className="model-phone-tier-list">
          {enabledTiers.map((tier) => (
            <section key={tier.tier} className="model-phone-tier">
              <div className="model-phone-tier-title">
                <span style={{ background: tier.color }}>{tier.label}</span>
                <small>{tier.cost_hint}</small>
              </div>
              {tier.models.map((model) => (
                <div
                  key={model.id}
                  className={`model-phone-row ${
                    model.id === props.catalog.default_model_id ? 'is-selected' : ''
                  }`}
                >
                  <i>{model.id === props.catalog.default_model_id ? '✓' : ''}</i>
                  <div>
                    <strong>{model.display_name}</strong>
                    <em>{model.tagline}</em>
                    <small>
                      输入 {model.price_input.toFixed(1)}✦ · 输出 {model.price_output.toFixed(1)}✦
                    </small>
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </Card>
  );
}
