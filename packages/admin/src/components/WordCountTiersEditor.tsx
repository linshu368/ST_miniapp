import { Button, Card, Col, Input, Popconfirm, Radio, Row, Space, Switch, Typography } from 'antd';
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
import type { WordCountTier, WordCountTiersConfig } from '@miniapp/shared';
import { useMemo, type CSSProperties, type ReactNode } from 'react';

function normalizeSortOrder(config: WordCountTiersConfig): WordCountTiersConfig {
  return {
    ...config,
    tiers: config.tiers.map((tier, index) => ({ ...tier, sort_order: index })),
  };
}

function SortableTierCard(props: { id: string; disabled?: boolean; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: props.disabled,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.75 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <Card
        size="small"
        title={
          <span
            {...attributes}
            {...listeners}
            style={{ cursor: props.disabled ? 'default' : 'grab' }}
          >
            ⋮⋮ 拖拽排序
          </span>
        }
      >
        {props.children}
      </Card>
    </div>
  );
}

export function WordCountTiersEditor(props: {
  value: WordCountTiersConfig;
  onChange: (value: WordCountTiersConfig) => void;
  disabled?: boolean;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const sortedTiers = useMemo(
    () => props.value.tiers.slice().sort((a, b) => a.sort_order - b.sort_order),
    [props.value.tiers]
  );

  const updateTier = (index: number, patch: Partial<WordCountTier>) => {
    const next = structuredClone(props.value);
    const ordered = next.tiers.slice().sort((a, b) => a.sort_order - b.sort_order);
    ordered[index] = { ...ordered[index], ...patch } as WordCountTier;
    next.tiers = ordered;
    props.onChange(normalizeSortOrder(next));
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sortedTiers.findIndex((tier) => tier.id === active.id);
    const newIndex = sortedTiers.findIndex((tier) => tier.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    props.onChange(
      normalizeSortOrder({
        ...props.value,
        tiers: arrayMove(sortedTiers, oldIndex, newIndex),
      })
    );
  };

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={16}>
        <Space direction="vertical" size="middle" className="editor-stack">
          <div>
            <Typography.Text>按钮列数（MiniApp 布局）</Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Radio.Group
                value={props.value.layout.columns}
                disabled={props.disabled}
                options={[
                  { label: '2 列', value: 2 },
                  { label: '3 列', value: 3 },
                  { label: '4 列', value: 4 },
                ]}
                onChange={(event) =>
                  props.onChange({
                    ...props.value,
                    layout: { columns: event.target.value as 2 | 3 | 4 },
                  })
                }
              />
            </div>
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={sortedTiers.map((tier) => tier.id)}
              strategy={verticalListSortingStrategy}
            >
              <Space direction="vertical" size="middle" className="editor-stack">
                {sortedTiers.map((tier, index) => (
                  <SortableTierCard key={tier.id} id={tier.id} disabled={props.disabled}>
                    <Space direction="vertical" size="small" className="editor-stack">
                      <Row gutter={[12, 12]}>
                        <Col xs={24} md={8}>
                          <Typography.Text>稳定 ID</Typography.Text>
                          <Input
                            value={tier.id}
                            disabled={props.disabled}
                            onChange={(event) => {
                              const nextId = event.target.value;
                              const next = structuredClone(props.value);
                              const ordered = next.tiers
                                .slice()
                                .sort((a, b) => a.sort_order - b.sort_order);
                              const wasDefault = next.default_tier_id === ordered[index]?.id;
                              ordered[index] = { ...ordered[index]!, id: nextId };
                              next.tiers = ordered;
                              if (wasDefault) next.default_tier_id = nextId;
                              props.onChange(normalizeSortOrder(next));
                            }}
                          />
                        </Col>
                        <Col xs={24} md={8}>
                          <Typography.Text>按钮文案</Typography.Text>
                          <Input
                            value={tier.ui_label}
                            maxLength={20}
                            showCount
                            disabled={props.disabled}
                            onChange={(event) =>
                              updateTier(index, { ui_label: event.target.value })
                            }
                          />
                        </Col>
                        <Col xs={24} md={8}>
                          <Typography.Text>注入 {'{{WORD_COUNT}}'}</Typography.Text>
                          <Input
                            value={tier.prompt_value}
                            maxLength={80}
                            showCount
                            disabled={props.disabled}
                            onChange={(event) =>
                              updateTier(index, { prompt_value: event.target.value })
                            }
                          />
                        </Col>
                      </Row>
                      <Space wrap>
                        <Switch
                          checked={tier.enabled}
                          disabled={props.disabled}
                          checkedChildren="启用"
                          unCheckedChildren="停用"
                          onChange={(enabled) => updateTier(index, { enabled })}
                        />
                        <Radio
                          checked={props.value.default_tier_id === tier.id}
                          disabled={props.disabled || !tier.enabled}
                          onChange={() =>
                            props.onChange({ ...props.value, default_tier_id: tier.id })
                          }
                        >
                          默认档
                        </Radio>
                        <Popconfirm
                          title="删除该档位？"
                          disabled={props.disabled || props.value.tiers.length <= 1}
                          onConfirm={() => {
                            const nextTiers = sortedTiers.filter((_, i) => i !== index);
                            props.onChange(
                              normalizeSortOrder({
                                ...props.value,
                                tiers: nextTiers,
                                default_tier_id: nextTiers.some(
                                  (item) => item.id === props.value.default_tier_id
                                )
                                  ? props.value.default_tier_id
                                  : (nextTiers.find((item) => item.enabled)?.id ??
                                    nextTiers[0]?.id ??
                                    ''),
                              })
                            );
                          }}
                        >
                          <Button
                            danger
                            size="small"
                            disabled={props.disabled || props.value.tiers.length <= 1}
                          >
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    </Space>
                  </SortableTierCard>
                ))}
              </Space>
            </SortableContext>
          </DndContext>

          <Button
            block
            disabled={props.disabled}
            onClick={() => {
              const id = `tier-${Date.now()}`;
              props.onChange(
                normalizeSortOrder({
                  ...props.value,
                  tiers: [
                    ...sortedTiers,
                    {
                      id,
                      ui_label: '新档位',
                      prompt_value: '',
                      enabled: true,
                      sort_order: sortedTiers.length,
                    },
                  ],
                })
              );
            }}
          >
            添加档位
          </Button>
        </Space>
      </Col>
      <Col xs={24} xl={8}>
        <div className="model-preview-sticky">
          <WordCountPhonePreview config={normalizeSortOrder(props.value)} />
        </div>
      </Col>
    </Row>
  );
}

function WordCountPhonePreview(props: { config: WordCountTiersConfig }) {
  const enabled = props.config.tiers
    .filter((tier) => tier.enabled)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
  const columns = props.config.layout.columns;

  return (
    <Card size="small" title="MiniApp 手机预览（当前草稿）">
      <div className="model-phone-preview word-count-phone-preview">
        <div className="model-phone-speaker" />
        <Typography.Title level={5} style={{ color: '#fff', margin: '10px 0 2px' }}>
          生成偏好
        </Typography.Title>
        <p className="word-count-phone-hint">对所有会话生效</p>
        <section className="word-count-phone-section">
          <h4>回复长度</h4>
          <div
            className="word-count-phone-grid"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {enabled.map((tier) => {
              const active = tier.id === props.config.default_tier_id;
              return (
                <button
                  key={tier.id}
                  type="button"
                  className={`word-count-phone-chip${active ? ' is-active' : ''}`}
                >
                  {tier.ui_label || tier.id}
                </button>
              );
            })}
          </div>
        </section>
        <section className="word-count-phone-section word-count-phone-row">
          <div>
            <strong>结尾给出选项</strong>
            <small>示意开关，不在本配置内</small>
          </div>
          <span className="word-count-phone-switch" />
        </section>
      </div>
    </Card>
  );
}
