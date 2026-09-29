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
  Table,
  Tag,
  Typography,
} from 'antd';
import { arrayMove } from '@dnd-kit/sortable';
import { useMemo, useState } from 'react';
import {
  LLM_MODEL_PROVIDER_LABELS,
  LLM_MODEL_PROVIDERS,
  type LlmModelProvider,
  type ModelCatalog,
  type ModelCatalogModel,
  type ModelCatalogTier,
  type ModelCatalogTierKey,
  type OpenRouterModelSummary,
  type ProviderModelDirectory,
  type ProviderModelSummary,
} from '@miniapp/shared';

const tierOptions: Array<{ value: ModelCatalogTierKey; label: string; color: string }> = [
  { value: 'light', label: 'Light', color: '#4ade80' },
  { value: 'standard', label: 'Standard', color: '#818cf8' },
  { value: 'premium', label: 'Premium', color: '#c084fc' },
];

export type ProviderDirectoryMap = Partial<Record<LlmModelProvider, ProviderModelDirectory>>;
type ProviderFlagMap = Partial<Record<LlmModelProvider, boolean>>;
type ProviderErrorMap = Partial<Record<LlmModelProvider, string | null>>;

function formatUsdPerMillion(value: number): string {
  return `$${(value * 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

export function filterOpenRouterModels(
  models: readonly OpenRouterModelSummary[],
  searchTerm: string
): OpenRouterModelSummary[] {
  const normalizedTerm = searchTerm.trim().toLocaleLowerCase();
  if (!normalizedTerm) return [...models];
  return models.filter((model) =>
    [model.name, model.id, model.canonical_slug, model.description]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLocaleLowerCase().includes(normalizedTerm))
  );
}

export function filterProviderModels(
  models: readonly ProviderModelSummary[],
  searchTerm: string
): ProviderModelSummary[] {
  const normalizedTerm = searchTerm.trim().toLocaleLowerCase();
  if (!normalizedTerm) return [...models];
  return models.filter((model) =>
    [model.name, model.id, model.description, model.raw_status_label]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLocaleLowerCase().includes(normalizedTerm))
  );
}

export interface DuplicateOpenRouterAssignment {
  stableId: string;
  displayName: string;
  tier: ModelCatalogTierKey;
  provider: LlmModelProvider;
  providerModelId: string;
}

function providerModelKey(provider: LlmModelProvider, providerModelId: string): string {
  return `${provider}:${providerModelId}`;
}

function modelProvider(model: ModelCatalogModel): LlmModelProvider {
  return model.provider ?? 'openrouter';
}

function modelProviderId(model: ModelCatalogModel): string {
  return model.provider_model_id || model.openrouter_model_id;
}

export function findDuplicateOpenRouterAssignments(
  catalog: ModelCatalog
): Record<string, DuplicateOpenRouterAssignment[]> {
  const assignments = new Map<string, DuplicateOpenRouterAssignment[]>();
  for (const tier of catalog.tiers) {
    for (const model of tier.models) {
      const provider = modelProvider(model);
      const providerModelId = modelProviderId(model).trim();
      if (!providerModelId) continue;
      const key = providerModelKey(provider, providerModelId);
      const current = assignments.get(key) ?? [];
      current.push({
        stableId: model.id,
        displayName: model.display_name,
        tier: tier.tier,
        provider,
        providerModelId,
      });
      assignments.set(key, current);
    }
  }
  return Object.fromEntries([...assignments.entries()].filter(([, models]) => models.length > 1));
}

function copyCatalog(value: ModelCatalog): ModelCatalog {
  return structuredClone(value);
}

function newModel(index: number, timestamp = Date.now()): ModelCatalogModel {
  return {
    id: `model-${timestamp}-${index}`,
    provider: 'openrouter',
    provider_model_id: '',
    openrouter_model_id: '',
    display_name: 'New Model',
    tagline: '',
    is_free: false,
    enabled: true,
    sort_order: index + 1,
  };
}

export function appendDraftModel(
  catalog: ModelCatalog,
  tierIndex: number,
  timestamp = Date.now()
): ModelCatalog {
  const next = copyCatalog(catalog);
  const models = next.tiers[tierIndex]?.models;
  if (!models) return catalog;
  const model = newModel(models.length, timestamp);
  models.push(model);
  if (!next.default_model_id) next.default_model_id = model.id;
  return next;
}

export function appendDraftTier(catalog: ModelCatalog): ModelCatalog {
  const used = new Set(catalog.tiers.map((tier) => tier.tier));
  const option = tierOptions.find((item) => !used.has(item.value));
  if (!option) return catalog;
  return {
    ...catalog,
    tiers: [
      ...catalog.tiers,
      {
        tier: option.value,
        label: option.label,
        color: option.color,
        cost_hint: '',
        sort_order: catalog.tiers.length,
        models: [],
      },
    ],
  };
}

export function mergeModelUpdate(
  current: ModelCatalogModel,
  patch: Partial<ModelCatalogModel>
): ModelCatalogModel {
  return { ...current, ...patch };
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
    if (!sourceTier || !targetTier || sourceTier.tier !== targetTier.tier) return catalog;
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
  providerDirectories: ProviderDirectoryMap;
  publishedModelIds: ReadonlySet<string>;
  syncLoading: ProviderFlagMap;
  syncError: ProviderErrorMap;
  onRefreshProvider: (provider: LlmModelProvider) => void;
}) {
  const [providerSearch, setProviderSearch] = useState<Partial<Record<LlmModelProvider, string>>>(
    {}
  );
  const duplicateAssignments = useMemo(
    () => findDuplicateOpenRouterAssignments(props.value),
    [props.value]
  );
  const selectedAssignments = useMemo(() => {
    const assignments = new Map<string, string[]>();
    for (const tier of props.value.tiers) {
      for (const model of tier.models) {
        const provider = modelProvider(model);
        const providerModelId = modelProviderId(model).trim();
        if (!providerModelId) continue;
        const key = providerModelKey(provider, providerModelId);
        assignments.set(key, [...(assignments.get(key) ?? []), model.id]);
      }
    }
    return assignments;
  }, [props.value]);

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
            items={props.value.tiers.map((tier, tierIndex) => ({
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
                        onChange={(event) =>
                          updateTier(tierIndex, { cost_hint: event.target.value })
                        }
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
            }))}
          />

          <Button
            disabled={props.disabled || props.value.tiers.length >= tierOptions.length}
            onClick={() => props.onChange(appendDraftTier(props.value))}
          >
            Add tier
          </Button>
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

function renderProviderDirectoryPanel(input: {
  provider: LlmModelProvider;
  directory: ProviderModelDirectory | null;
  search: string;
  loading: boolean;
  error: string | null;
  onSearch: (value: string) => void;
  onRefresh: () => void;
}) {
  const label = LLM_MODEL_PROVIDER_LABELS[input.provider];
  const filteredModels = filterProviderModels(input.directory?.models ?? [], input.search);
  return {
    key: `${input.provider}-directory`,
    label: (
      <Space wrap>
        <Typography.Text strong>{label} model directory</Typography.Text>
        {input.directory ? (
          <Tag color={input.directory.stale ? 'orange' : 'green'}>
            {input.directory.stale ? 'cached' : 'synced'} · {input.directory.models.length} models
          </Tag>
        ) : (
          <Tag>not synced</Tag>
        )}
      </Space>
    ),
    extra: (
      <Button
        size="small"
        loading={input.loading}
        onClick={(event) => {
          event.stopPropagation();
          input.onRefresh();
        }}
      >
        Refresh
      </Button>
    ),
    children: (
      <Space direction="vertical" size="middle" className="field-full">
        {input.error ? <Alert type="error" showIcon message={input.error} /> : null}
        {input.directory ? (
          <>
            <Typography.Text type="secondary">
              Updated at{' '}
              {new Date(input.directory.fetched_at).toLocaleString('zh-CN', { hour12: false })}.
              Loaded {input.directory.models.length} models.
            </Typography.Text>
            <Input.Search
              allowClear
              value={input.search}
              placeholder={`Search ${label} models`}
              onChange={(event) => input.onSearch(event.target.value)}
              suffix={
                <Typography.Text type="secondary">
                  {filteredModels.length} / {input.directory.models.length}
                </Typography.Text>
              }
            />
            <Table<ProviderModelSummary>
              key={`${input.provider}:${input.search.trim().toLocaleLowerCase()}`}
              rowKey="id"
              size="small"
              dataSource={filteredModels}
              locale={{ emptyText: `No matching ${label} models` }}
              scroll={{ x: 1120 }}
              pagination={{
                defaultPageSize: 20,
                showSizeChanger: true,
                pageSizeOptions: [20, 50, 100],
                showTotal: (total) => `${total} models`,
              }}
              columns={[
                {
                  title: 'Model',
                  key: 'model',
                  fixed: 'left',
                  width: 280,
                  render: (_, model) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{model.name}</Typography.Text>
                      <Typography.Text type="secondary" copyable>
                        {model.id}
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: 'Context',
                  dataIndex: 'context_length',
                  width: 110,
                  render: (value: number | null) =>
                    value === null ? 'unknown' : value.toLocaleString('en-US'),
                },
                {
                  title: 'Input',
                  dataIndex: 'prompt_usd_per_token',
                  width: 135,
                  render: (value: number) => `${formatUsdPerMillion(value)} / 1M tokens`,
                },
                {
                  title: 'Output',
                  dataIndex: 'completion_usd_per_token',
                  width: 135,
                  render: (value: number) => `${formatUsdPerMillion(value)} / 1M tokens`,
                },
                {
                  title: 'Status',
                  key: 'status',
                  width: 120,
                  render: (_, model) =>
                    model.status === 'available' ? (
                      <Tag color="green">available</Tag>
                    ) : (
                      <Tag color="red">{model.raw_status_label ?? model.status}</Tag>
                    ),
                },
              ]}
            />
          </>
        ) : (
          <Alert
            type="info"
            showIcon
            message={`${label} directory has not been synced. Click Refresh to load it.`}
          />
        )}
      </Space>
    ),
  };
}

function renderModelCard(input: {
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
}) {
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
        <Col xs={24} md={8}>
          <Typography.Text>Stable ID</Typography.Text>
          <Input
            value={input.model.id}
            disabled={input.disabled || input.publishedModelIds.has(input.model.id)}
            maxLength={64}
            status={
              /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(input.model.id) ? undefined : 'error'
            }
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
        <Col xs={24} md={8}>
          <Typography.Text>Free quota model</Typography.Text>
          <Select
            className="field-full"
            value={input.model.is_free}
            options={[
              { value: true, label: 'Yes' },
              { value: false, label: 'No' },
            ]}
            disabled={input.disabled}
            onChange={(is_free) =>
              input.onModelChange(input.tierIndex, input.modelIndex, { is_free })
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

function ModelCatalogPhonePreview(props: { catalog: ModelCatalog }) {
  const enabledTiers = props.catalog.tiers
    .map((tier) => ({ ...tier, models: tier.models.filter((model) => model.enabled) }))
    .filter((tier) => tier.models.length > 0);

  return (
    <Card size="small" title="MiniApp preview">
      <div className="model-phone-preview">
        <div className="model-phone-speaker" />
        <Typography.Title level={5} style={{ color: '#fff', margin: '10px 0 2px' }}>
          Choose story engine
        </Typography.Title>
        <div className="model-phone-tier-list">
          {enabledTiers.map((tier) => (
            <section key={tier.tier} className="model-phone-tier">
              <div className="model-phone-tier-title">
                <span style={{ background: tier.color }}>{tier.label}</span>
                <small className="model-phone-cost-hint">{tier.cost_hint}</small>
              </div>
              {tier.models.map((model) => (
                <div
                  key={model.id}
                  className={`model-phone-row ${
                    model.id === props.catalog.default_model_id ? 'is-selected' : ''
                  }`}
                >
                  <i>{model.id === props.catalog.default_model_id ? 'v' : ''}</i>
                  <div>
                    <strong>
                      {model.display_name}
                      {model.is_free ? <span className="model-phone-free-badge">free</span> : null}
                    </strong>
                    <em>{model.tagline}</em>
                    <small className="model-phone-row-spacer" aria-hidden>
                      &nbsp;
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
