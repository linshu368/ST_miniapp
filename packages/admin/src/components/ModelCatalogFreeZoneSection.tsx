import {
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import {
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  LLM_MODEL_PROVIDER_LABELS,
  LLM_MODEL_PROVIDERS,
  type CatalogFreeZoneModel,
  type ModelCatalog,
  type ModelCatalogTierKey,
} from '@miniapp/shared';
import type { ProviderDirectoryMap } from './ModelCatalogEditor';

/** Surplus 模型走畅聊候选池（带折扣底线和评估），这里只放其他平台的模型 */
type FreeProvider = CatalogFreeZoneModel['provider'];
const PROVIDERS = LLM_MODEL_PROVIDERS.filter(
  (provider): provider is FreeProvider => provider !== 'surplus'
);
const TIER_OPTIONS: Array<{ value: ModelCatalogTierKey; label: string }> = [
  { value: 'light', label: '轻量' },
  { value: 'standard', label: '标准' },
  { value: 'premium', label: '旗舰' },
];
const ID_PATTERN = /^free-[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export function newFreeZoneModel(timestamp = Date.now()): CatalogFreeZoneModel {
  return {
    id: `free-model-${timestamp}`,
    provider: 'openrouter',
    provider_model_id: '',
    display_name: '新免费模型',
    tagline: '',
    family: '',
    benchmark_tier: 'standard',
    first_token_timeout_ms: DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
    turns_per_24h: null,
    enabled: true,
  };
}

/**
 * 模型目录里的「免费畅聊」板块：这里的模型直接出现在对话页畅聊栏目，和轻量/标准/旗舰同一条通路
 * （一次首发 + 兜底），没有候选池那套评估和自动上下架。
 */
export function ModelCatalogFreeZoneSection(props: {
  value: ModelCatalog;
  onChange: (value: ModelCatalog) => void;
  disabled?: boolean;
  providerDirectories: ProviderDirectoryMap;
  publishedModelIds: ReadonlySet<string>;
}) {
  const models = props.value.free_zone_models ?? [];
  const setModels = (next: CatalogFreeZoneModel[]) =>
    props.onChange({ ...props.value, free_zone_models: next });
  const update = (index: number, patch: Partial<CatalogFreeZoneModel>) =>
    setModels(models.map((model, at) => (at === index ? { ...model, ...patch } : model)));
  const move = (index: number, offset: -1 | 1) => {
    const next = [...models];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(index + offset, 0, moved);
    setModels(next);
  };

  return (
    <Card size="small" title={`免费畅聊 · ${models.length} 个模型`}>
      <Space direction="vertical" size="middle" className="editor-stack">
        <Typography.Text type="secondary">
          这里的模型会直接出现在对话页「畅聊」栏目里，遵守畅聊的开关、福利期和使用范围，本轮扣 0
          星尘、按对标档位显示划线原价。通路和轻量/标准/旗舰一样：一次首发 +
          兜底，没有初筛、探测、在架评估和自动上下架，停用或删除就下架。Surplus
          模型请放到「畅聊」配置的候选池。顺序排在候选池上架的模型后面。每人 24
          小时上限留空时，用「畅聊」配置里「用量上限」的全局值。
        </Typography.Text>
        {models.map((model, index) => (
          <FreeZoneModelCard
            key={`${index}-${model.id}`}
            model={model}
            index={index}
            count={models.length}
            disabled={props.disabled}
            idLocked={props.publishedModelIds.has(model.id)}
            providerDirectories={props.providerDirectories}
            onChange={(patch) => update(index, patch)}
            onMove={(offset) => move(index, offset)}
            onDelete={() => setModels(models.filter((_, at) => at !== index))}
          />
        ))}
        <Button
          block
          disabled={props.disabled || models.length >= 20}
          onClick={() => setModels([...models, newFreeZoneModel()])}
        >
          添加免费模型
        </Button>
      </Space>
    </Card>
  );
}

function FreeZoneModelCard(props: {
  model: CatalogFreeZoneModel;
  index: number;
  count: number;
  disabled?: boolean;
  idLocked: boolean;
  providerDirectories: ProviderDirectoryMap;
  onChange: (patch: Partial<CatalogFreeZoneModel>) => void;
  onMove: (offset: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { model, disabled } = props;
  return (
    <Card
      size="small"
      title={model.display_name || '未命名'}
      extra={
        <CardActions
          disabled={disabled}
          first={props.index === 0}
          last={props.index === props.count - 1}
          onMove={props.onMove}
          onDelete={props.onDelete}
        />
      }
    >
      <Row gutter={[12, 12]}>
        <Col xs={24} md={8}>
          <Typography.Text>免费模型 id（free- 开头，发布后不能改）</Typography.Text>
          <Input
            value={model.id}
            maxLength={64}
            disabled={disabled || props.idLocked}
            status={ID_PATTERN.test(model.id) ? undefined : 'error'}
            onChange={(event) => props.onChange({ id: event.target.value })}
          />
        </Col>
        <UpstreamFields
          model={model}
          disabled={disabled}
          providerDirectories={props.providerDirectories}
          onChange={props.onChange}
        />
        <Col xs={24} md={8}>
          <Typography.Text>显示名</Typography.Text>
          <Input
            value={model.display_name}
            maxLength={40}
            showCount
            disabled={disabled}
            onChange={(event) => props.onChange({ display_name: event.target.value })}
          />
        </Col>
        <Col xs={24} md={8}>
          <Typography.Text>介绍语（可留空）</Typography.Text>
          <Input
            value={model.tagline}
            maxLength={40}
            showCount
            disabled={disabled}
            onChange={(event) => props.onChange({ tagline: event.target.value })}
          />
        </Col>
        <Col xs={24} md={8}>
          <Typography.Text>系列（如 deepseek、gemini）</Typography.Text>
          <Input
            value={model.family}
            maxLength={40}
            disabled={disabled}
            status={model.family.trim() ? undefined : 'error'}
            onChange={(event) => props.onChange({ family: event.target.value })}
          />
        </Col>
        <Col xs={24} md={8}>
          <Typography.Text>对标档位（决定划线原价）</Typography.Text>
          <Select<ModelCatalogTierKey>
            className="field-full"
            value={model.benchmark_tier}
            disabled={disabled}
            options={TIER_OPTIONS}
            onChange={(benchmark_tier) => props.onChange({ benchmark_tier })}
          />
        </Col>
        <UsageFields model={model} disabled={disabled} onChange={props.onChange} />
      </Row>
    </Card>
  );
}

function CardActions(props: {
  disabled?: boolean;
  first: boolean;
  last: boolean;
  onMove: (offset: -1 | 1) => void;
  onDelete: () => void;
}) {
  return (
    <Space>
      <Button
        size="small"
        disabled={props.disabled || props.first}
        onClick={() => props.onMove(-1)}
      >
        上移
      </Button>
      <Button size="small" disabled={props.disabled || props.last} onClick={() => props.onMove(1)}>
        下移
      </Button>
      <Popconfirm title="删除这个免费模型？" disabled={props.disabled} onConfirm={props.onDelete}>
        <Button danger size="small" disabled={props.disabled}>
          删除
        </Button>
      </Popconfirm>
    </Space>
  );
}

/** 启动兜底等待、每人 24 小时上限、启用 */
function UsageFields(props: {
  model: CatalogFreeZoneModel;
  disabled?: boolean;
  onChange: (patch: Partial<CatalogFreeZoneModel>) => void;
}) {
  const { model, disabled } = props;
  return (
    <>
      <Col xs={12} md={8}>
        <Typography.Text>启动兜底等待（毫秒）</Typography.Text>
        <InputNumber
          className="field-full"
          min={1}
          max={110_000}
          step={500}
          value={model.first_token_timeout_ms ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS}
          disabled={disabled}
          onChange={(value) =>
            props.onChange({ first_token_timeout_ms: value ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS })
          }
        />
      </Col>
      <Col xs={12} md={8}>
        <Typography.Text>每人 24 小时上限（轮）</Typography.Text>
        <InputNumber
          className="field-full"
          min={1}
          max={5000}
          precision={0}
          placeholder="留空用全局"
          // 旧目录里没有这一项：空着 = 用畅聊配置的全局上限
          value={model.turns_per_24h ?? null}
          disabled={disabled}
          onChange={(value) => props.onChange({ turns_per_24h: value ?? null })}
        />
      </Col>
      <Col xs={12} md={8}>
        <Typography.Text>启用</Typography.Text>
        <div>
          <Switch
            checked={model.enabled}
            disabled={disabled}
            onChange={(enabled) => props.onChange({ enabled })}
          />
        </div>
      </Col>
    </>
  );
}

/** 模型平台 + 从已同步的模型目录里选上游模型 */
function UpstreamFields(props: {
  model: CatalogFreeZoneModel;
  disabled?: boolean;
  providerDirectories: ProviderDirectoryMap;
  onChange: (patch: Partial<CatalogFreeZoneModel>) => void;
}) {
  const { model, disabled } = props;
  const directory = props.providerDirectories[model.provider] ?? null;
  const modelOptions = (directory?.models ?? []).map((item) => ({
    value: item.id,
    label: `${item.name} (${item.id})`,
  }));
  return (
    <>
      <Col xs={24} md={8}>
        <Typography.Text>模型平台</Typography.Text>
        <Select<FreeProvider>
          className="field-full"
          value={model.provider}
          disabled={disabled}
          options={PROVIDERS.map((provider) => ({
            value: provider,
            label: LLM_MODEL_PROVIDER_LABELS[provider],
          }))}
          onChange={(provider) => props.onChange({ provider, provider_model_id: '' })}
        />
      </Col>
      <Col xs={24} md={8}>
        <Typography.Text>{LLM_MODEL_PROVIDER_LABELS[model.provider]} 模型 ID</Typography.Text>
        <Select
          className="field-full"
          value={model.provider_model_id || undefined}
          showSearch
          optionFilterProp="label"
          options={modelOptions}
          placeholder={directory ? '从已同步的模型里选' : '先在上方同步这个平台的模型目录'}
          disabled={disabled || !directory}
          onChange={(providerModelId: string) => {
            const upstream = directory?.models.find((item) => item.id === providerModelId);
            props.onChange({
              provider_model_id: providerModelId,
              ...(upstream && model.display_name === '新免费模型'
                ? { display_name: upstream.name.slice(0, 40) }
                : {}),
            });
          }}
        />
      </Col>
    </>
  );
}
