import {
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';

import {
  LLM_MODEL_PROVIDER_LABELS,
  LLM_MODEL_PROVIDERS,
  type ModelCatalog,
  type ModelCatalogModel,
  type ModelCatalogTier,
} from '@miniapp/shared';

import {
  copyCatalog,
  modelProvider,
  modelProviderId,
  providerModelKey,
  type DuplicateOpenRouterAssignment,
  type ProviderDirectoryMap,
} from './model-catalog-helpers';
interface ModelCardInput {
  catalog: ModelCatalog;
  model: ModelCatalogModel;
  tier: ModelCatalogTier;
  tierIndex: number;
  modelIndex: number;
  disabled?: boolean;
  providerDirectories: ProviderDirectoryMap;
  selectedAssignments: Map<string, string[]>;
  duplicateAssignments: Record<string, DuplicateOpenRouterAssignment[]>;
  publishedModelIds: ReadonlySet<string>;
  onCatalogChange: (catalog: ModelCatalog) => void;
  onModelChange: (tierIndex: number, modelIndex: number, patch: Partial<ModelCatalogModel>) => void;
}

export function renderModelCard(input: ModelCardInput) {
  return (
    <Card
      key={`${input.tier.tier}-${input.model.id}`}
      size="small"
      title={
        <Space>
          <Radio
            checked={input.catalog.default_model_id === input.model.id}
            disabled={input.disabled}
            onChange={() =>
              input.onCatalogChange({ ...input.catalog, default_model_id: input.model.id })
            }
          />
          <span>{input.model.display_name || 'Unnamed model'}</span>
        </Space>
      }
      extra={
        <Popconfirm
          title="Delete this model?"
          disabled={input.disabled}
          onConfirm={() => {
            const next = copyCatalog(input.catalog);
            next.tiers[input.tierIndex].models.splice(input.modelIndex, 1);
            if (next.default_model_id === input.model.id) {
              next.default_model_id = next.tiers.flatMap((item) => item.models)[0]?.id ?? '';
            }
            input.onCatalogChange(next);
          }}
        >
          <Button danger size="small" disabled={input.disabled}>
            Delete
          </Button>
        </Popconfirm>
      }
    >
      <Row gutter={[12, 12]}>
        <ModelProviderFields {...input} />
        <Col xs={24} md={8}>
          <Typography.Text>Display name</Typography.Text>
          <Input
            value={input.model.display_name}
            maxLength={40}
            showCount
            disabled={input.disabled}
            onChange={(event) =>
              input.onModelChange(input.tierIndex, input.modelIndex, {
                display_name: event.target.value,
              })
            }
          />
        </Col>
        <Col xs={24} md={8}>
          <Typography.Text>Tagline</Typography.Text>
          <Input
            value={input.model.tagline}
            maxLength={40}
            showCount
            disabled={input.disabled}
            onChange={(event) =>
              input.onModelChange(input.tierIndex, input.modelIndex, {
                tagline: event.target.value,
              })
            }
          />
        </Col>
        <Col xs={12} md={4}>
          <Typography.Text>Sort</Typography.Text>
          <InputNumber className="field-full" value={input.model.sort_order} disabled />
        </Col>
        <Col xs={12} md={4}>
          <Typography.Text>Enabled</Typography.Text>
          <div>
            <Switch
              checked={input.model.enabled}
              disabled={input.disabled}
              onChange={(enabled) =>
                input.onModelChange(input.tierIndex, input.modelIndex, { enabled })
              }
            />
          </div>
        </Col>
      </Row>
    </Card>
  );
}

function ModelProviderFields(input: ModelCardInput) {
  const provider = modelProvider(input.model);
  const providerModelId = modelProviderId(input.model);
  const directory = input.providerDirectories[provider] ?? null;
  const duplicateKey = providerModelId ? providerModelKey(provider, providerModelId) : '';
  const duplicate = duplicateKey ? input.duplicateAssignments[duplicateKey] : undefined;
  const providerOptions = LLM_MODEL_PROVIDERS.map((item) => ({
    value: item,
    label: LLM_MODEL_PROVIDER_LABELS[item],
  }));
  const modelOptions = (directory?.models ?? []).map((item) => {
    const key = providerModelKey(provider, item.id);
    return {
      value: item.id,
      label: `${item.name} (${item.id})`,
      disabled:
        item.id !== providerModelId && (input.selectedAssignments.get(key)?.length ?? 0) > 0,
    };
  });

  return (
    <>
      <Col xs={24} md={8}>
        <Typography.Text>Stable ID</Typography.Text>
        <Input
          value={input.model.id}
          disabled={input.disabled || input.publishedModelIds.has(input.model.id)}
          maxLength={64}
          status={/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(input.model.id) ? undefined : 'error'}
          onChange={(event) =>
            input.onModelChange(input.tierIndex, input.modelIndex, { id: event.target.value })
          }
        />
      </Col>
      <Col xs={24} md={8}>
        <Typography.Text>Model source platform</Typography.Text>
        <Select
          className="field-full"
          value={provider}
          options={providerOptions}
          disabled={input.disabled}
          onChange={(nextProvider) =>
            input.onModelChange(input.tierIndex, input.modelIndex, {
              provider: nextProvider,
              provider_model_id: '',
              openrouter_model_id: '',
            })
          }
        />
      </Col>
      <Col xs={24} md={8}>
        <Typography.Text>{LLM_MODEL_PROVIDER_LABELS[provider]} model ID</Typography.Text>
        <Select
          className="field-full"
          value={providerModelId || undefined}
          status={duplicate ? 'error' : undefined}
          showSearch
          optionFilterProp="label"
          options={modelOptions}
          placeholder="Select a synced provider model"
          disabled={input.disabled || !directory}
          onChange={(nextProviderModelId) => {
            const upstream = directory?.models.find((item) => item.id === nextProviderModelId);
            input.onModelChange(input.tierIndex, input.modelIndex, {
              provider,
              provider_model_id: nextProviderModelId,
              openrouter_model_id: nextProviderModelId,
              ...(upstream ? { display_name: upstream.name } : {}),
            });
          }}
        />
        {duplicate ? (
          <Typography.Text type="danger">
            Duplicate mapping:{' '}
            {duplicate
              .map((item) => `${item.displayName || 'Unnamed'} (${item.stableId})`)
              .join(', ')}
          </Typography.Text>
        ) : null}
      </Col>
    </>
  );
}
