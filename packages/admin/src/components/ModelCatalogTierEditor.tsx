import { Button, Col, Input, InputNumber, Row, Select, Space, Typography } from 'antd';
import type { ModelCatalogModel, ModelCatalogTier } from '@miniapp/shared';
import type { ModelCatalogEditorProps } from './ModelCatalogEditor';
import {
  appendDraftModel,
  tierOptions,
  type DuplicateOpenRouterAssignment,
} from './model-catalog-helpers';
import { renderModelCard } from './ModelCatalogCard';

interface TierActions {
  updateTier(index: number, patch: Partial<ModelCatalogTier>): void;
  updateModel(tierIndex: number, modelIndex: number, patch: Partial<ModelCatalogModel>): void;
  selectedAssignments: Map<string, string[]>;
  duplicateAssignments: Record<string, DuplicateOpenRouterAssignment[]>;
}
export function renderCatalogTier(
  tier: ModelCatalogTier,
  tierIndex: number,
  props: ModelCatalogEditorProps,
  actions: TierActions
) {
  const { updateTier, updateModel, selectedAssignments, duplicateAssignments } = actions;
  return {
    key: tier.tier,
    label: `${tier.label} · ${tier.models.length} models`,
    children: (
      <Space direction="vertical" size="middle" className="editor-stack">
        <Row gutter={[12, 12]}>
          <Col xs={24} md={6}>
            <Typography.Text>Tier</Typography.Text>
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
            <Typography.Text>Display name</Typography.Text>
            <Input
              value={tier.label}
              maxLength={20}
              showCount
              disabled={props.disabled}
              onChange={(event) => updateTier(tierIndex, { label: event.target.value })}
            />
          </Col>
          <Col xs={24} md={6}>
            <Typography.Text>Color</Typography.Text>
            <Input
              value={tier.color}
              disabled={props.disabled}
              maxLength={7}
              status={/^#[0-9a-fA-F]{6}$/.test(tier.color) ? undefined : 'error'}
              onChange={(event) => updateTier(tierIndex, { color: event.target.value })}
            />
          </Col>
          <Col xs={24} md={6}>
            <Typography.Text>Sort</Typography.Text>
            <InputNumber className="field-full" value={tier.sort_order} disabled />
          </Col>
          <Col span={24}>
            <Typography.Text>Cost hint</Typography.Text>
            <Input
              value={tier.cost_hint}
              maxLength={50}
              showCount
              disabled={props.disabled}
              onChange={(event) => updateTier(tierIndex, { cost_hint: event.target.value })}
            />
          </Col>
        </Row>

        {tier.models.map((model, modelIndex) =>
          renderModelCard({
            catalog: props.value,
            model,
            tier,
            tierIndex,
            modelIndex,
            disabled: props.disabled,
            providerDirectories: props.providerDirectories,
            selectedAssignments,
            duplicateAssignments,
            publishedModelIds: props.publishedModelIds,
            onCatalogChange: props.onChange,
            onModelChange: updateModel,
          })
        )}

        <Button
          block
          disabled={props.disabled}
          onClick={() => props.onChange(appendDraftModel(props.value, tierIndex))}
        >
          Add model
        </Button>
      </Space>
    ),
  };
}
