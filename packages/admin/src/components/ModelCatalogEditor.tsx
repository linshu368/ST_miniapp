import { renderCatalogTier } from './ModelCatalogTierEditor';
import { Alert, Button, Card, Col, Collapse, Row, Select, Space, Typography } from 'antd';

import { useMemo, useState } from 'react';
import { ModelCatalogFreeZoneSection } from './ModelCatalogFreeZoneSection';
import {
  LLM_MODEL_PROVIDERS,
  type LlmModelProvider,
  type ModelCatalog,
  type ModelCatalogModel,
  type ModelCatalogTier,
} from '@miniapp/shared';

import {
  appendDraftTier,
  copyCatalog,
  findDuplicateOpenRouterAssignments,
  mergeModelUpdate,
  selectedCatalogAssignments,
  normalizeCatalogSortOrder,
  tierOptions,
  type ProviderDirectoryMap,
} from './model-catalog-helpers';

import { renderProviderDirectoryPanel } from './ModelProviderDirectoryPanel';
import { ModelCatalogPhonePreview } from './ModelCatalogPhonePreview';
export * from './model-catalog-helpers';
type ProviderFlagMap = Partial<Record<LlmModelProvider, boolean>>;
type ProviderErrorMap = Partial<Record<LlmModelProvider, string | null>>;
export interface ModelCatalogEditorProps {
  value: ModelCatalog;
  onChange: (value: ModelCatalog) => void;
  disabled?: boolean;
  providerDirectories: ProviderDirectoryMap;
  publishedModelIds: ReadonlySet<string>;
  syncLoading: ProviderFlagMap;
  syncError: ProviderErrorMap;
  onRefreshProvider: (provider: LlmModelProvider) => void;
}

export function ModelCatalogEditor(props: ModelCatalogEditorProps) {
  const [providerSearch, setProviderSearch] = useState<Partial<Record<LlmModelProvider, string>>>(
    {}
  );
  const duplicateAssignments = useMemo(
    () => findDuplicateOpenRouterAssignments(props.value),
    [props.value]
  );
  const selectedAssignments = useMemo(() => selectedCatalogAssignments(props.value), [props.value]);

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
    next.tiers[tierIndex].models[modelIndex] = mergeModelUpdate(
      next.tiers[tierIndex].models[modelIndex],
      patch
    );
    props.onChange(next);
  };

  return (
    <Row gutter={[20, 20]} align="top">
      <Col xs={24} xl={16}>
        <Space direction="vertical" size="middle" className="editor-stack">
          {Object.keys(duplicateAssignments).length > 0 ? (
            <Alert
              type="error"
              showIcon
              message="Duplicate provider model mapping"
              description="Each provider model can only be mapped to one catalog card."
            />
          ) : null}

          <Collapse
            items={LLM_MODEL_PROVIDERS.map((provider) =>
              renderProviderDirectoryPanel({
                provider,
                directory: props.providerDirectories[provider] ?? null,
                search: providerSearch[provider] ?? '',
                loading: Boolean(props.syncLoading[provider]),
                error: props.syncError[provider] ?? null,
                onSearch: (search) =>
                  setProviderSearch((current) => ({ ...current, [provider]: search })),
                onRefresh: () => props.onRefreshProvider(provider),
              })
            )}
          />

          <Card size="small">
            <Space direction="vertical" className="field-full">
              <Typography.Text strong>Default model</Typography.Text>
              <Select
                value={props.value.default_model_id}
                disabled={props.disabled}
                options={props.value.tiers.flatMap((tier) =>
                  tier.models.map((model) => ({
                    value: model.id,
                    label: `${model.display_name} (${model.id})`,
                  }))
                )}
                onChange={(default_model_id) =>
                  props.onChange({ ...props.value, default_model_id })
                }
              />
            </Space>
          </Card>

          <Collapse
            defaultActiveKey={props.value.tiers.map((tier) => tier.tier)}
            items={props.value.tiers.map((tier, tierIndex) =>
              renderCatalogTier(tier, tierIndex, props, {
                updateTier,
                updateModel,
                selectedAssignments,
                duplicateAssignments,
              })
            )}
          />

          <Button
            disabled={props.disabled || props.value.tiers.length >= tierOptions.length}
            onClick={() => props.onChange(appendDraftTier(props.value))}
          >
            Add tier
          </Button>

          <ModelCatalogFreeZoneSection
            value={props.value}
            onChange={props.onChange}
            disabled={props.disabled}
            providerDirectories={props.providerDirectories}
            publishedModelIds={props.publishedModelIds}
          />
        </Space>
      </Col>
      <Col xs={24} xl={8}>
        <div className="model-preview-sticky">
          <ModelCatalogPhonePreview catalog={normalizeCatalogSortOrder(props.value)} />
        </div>
      </Col>
    </Row>
  );
}
