import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useRef, useState } from 'react';
import { fetchSurplusProviderMarket } from '@miniapp/admin-client';
import {
  SURPLUS_ALWAYS_BLOCKED_PROVIDERS,
  type ProviderModelDirectory,
  type SurplusProviderMarket,
  type SurplusProviderMarketRow,
} from '@miniapp/shared';
import { useAdminApi } from '../lib/adminApiContext';

/**
 * 「模型供应商路由」的 Surplus 规则（surplus_rules）。和 OpenRouter 规则同一套「编辑宽、落库严」：
 * 本地态允许暂空，保存草稿时由 LlmProviderRoutingConfigSchema 把关。
 */

export interface EditableSurplusRule {
  surplus_model_id: string;
  allowed_providers: string[];
  preferred_providers: string[];
  blocked_providers: string[];
  min_discount_pct: number | null;
  route_objective: 'latency' | 'reliability' | null;
  price_tolerance_pct: number | null;
  note: string;
}

const EMPTY_RULE: EditableSurplusRule = {
  surplus_model_id: '',
  allowed_providers: [],
  preferred_providers: [],
  blocked_providers: [],
  min_discount_pct: null,
  route_objective: null,
  price_tolerance_pct: null,
  note: '',
};

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeSurplusRules(value: unknown): EditableSurplusRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((rule): rule is Record<string, unknown> => !!rule && typeof rule === 'object')
    .map((rule) => ({
      surplus_model_id: typeof rule.surplus_model_id === 'string' ? rule.surplus_model_id : '',
      allowed_providers: strings(rule.allowed_providers),
      preferred_providers: strings(rule.preferred_providers),
      blocked_providers: strings(rule.blocked_providers),
      min_discount_pct: numberOrNull(rule.min_discount_pct),
      route_objective:
        rule.route_objective === 'latency' || rule.route_objective === 'reliability'
          ? rule.route_objective
          : null,
      price_tolerance_pct: numberOrNull(rule.price_tolerance_pct),
      note: typeof rule.note === 'string' ? rule.note : '',
    }));
}

const percent = (value: number | null) => (value === null ? '—' : `${value}%`);

function providerOptionLabel(row: SurplusProviderMarketRow): string {
  const flags = [
    row.always_blocked ? '已统一屏蔽' : null,
    row.trusted ? null : '不可信，默认派不到',
  ].filter(Boolean);
  return `${row.provider} · 最高 ${percent(row.best_discount_pct)} · ${row.available_offers} 家在线${
    flags.length ? `（${flags.join('，')}）` : ''
  }`;
}

/** 按「环境 + 模型」记住最近一次报价；切环境、换模型后迟到的响应直接丢弃。 */
function useSurplusMarkets() {
  const api = useAdminApi();
  const [markets, setMarkets] = useState<Record<string, SurplusProviderMarket>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const environment = useRef(api?.environment);
  environment.current = api?.environment;
  const keyOf = (model: string) => `${api?.environment}:${model.trim().toLowerCase()}`;
  const load = async (model: string) => {
    if (!api || !model.trim()) return;
    const key = keyOf(model);
    const requestedIn = api.environment;
    setLoading((current) => ({ ...current, [key]: true }));
    setErrors((current) => ({ ...current, [key]: '' }));
    try {
      const market = await fetchSurplusProviderMarket(api.client, api.apiUrl(), model.trim());
      if (environment.current === requestedIn)
        setMarkets((current) => ({ ...current, [key]: market }));
    } catch {
      if (environment.current === requestedIn)
        setErrors((current) => ({ ...current, [key]: 'Surplus 报价暂时读不到，稍后再试' }));
    } finally {
      setLoading((current) => ({ ...current, [key]: false }));
    }
  };
  return {
    available: !!api,
    load,
    market: (model: string) => markets[keyOf(model)],
    loading: (model: string) => loading[keyOf(model)] === true,
    error: (model: string) => errors[keyOf(model)] || null,
  };
}

function MarketTable({ market }: { market: SurplusProviderMarket }) {
  return (
    <Space direction="vertical" className="field-full">
      {market.performance_status === 'failed' ? (
        <Alert type="warning" showIcon message="24 小时表现暂时读不到，只显示报价" />
      ) : null}
      <Table<SurplusProviderMarketRow>
        size="small"
        rowKey="provider"
        pagination={false}
        scroll={{ x: true }}
        dataSource={market.providers}
        columns={[
          {
            title: '供应商',
            dataIndex: 'provider',
            render: (provider: string, row) => (
              <Space size={4} wrap>
                <Typography.Text>{provider}</Typography.Text>
                {row.always_blocked ? <Tag color="red">已统一屏蔽</Tag> : null}
                {row.trusted ? null : <Tag>不可信</Tag>}
              </Space>
            ),
          },
          {
            title: '在线卖家',
            render: (_, row) => `${row.available_offers} / ${row.offers}`,
          },
          { title: '最高折扣', render: (_, row) => percent(row.best_discount_pct) },
          { title: '中位折扣', render: (_, row) => percent(row.median_discount_pct) },
          {
            title: '首字 p50',
            render: (_, row) =>
              row.ttft_p50_ms === null ? '—' : `${(row.ttft_p50_ms / 1000).toFixed(1)}s`,
          },
          { title: '可用率', render: (_, row) => percent(row.uptime_pct) },
        ]}
      />
      <Typography.Text type="secondary">
        折扣相对外部直购价；首字和可用率是 Surplus 全平台 24 小时口径。查询于{' '}
        {new Date(market.fetched_at).toLocaleString()}
      </Typography.Text>
    </Space>
  );
}

function ProviderSelect(props: {
  value: string[];
  disabled?: boolean;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string[]) => void;
}) {
  return (
    <Select
      mode="tags"
      className="field-full"
      value={props.value}
      options={props.options}
      disabled={props.disabled}
      placeholder={props.placeholder}
      tokenSeparators={[',', ' ']}
      onChange={props.onChange}
    />
  );
}

type SurplusMarkets = ReturnType<typeof useSurplusMarkets>;
type ProviderOptions = Array<{ value: string; label: string }>;

export function SurplusRoutingRulesEditor(props: {
  rules: EditableSurplusRule[];
  disabled?: boolean;
  onChange: (rules: EditableSurplusRule[]) => void;
  surplusDirectory: ProviderModelDirectory | null;
}) {
  const markets = useSurplusMarkets();
  const modelOptions = (props.surplusDirectory?.models ?? []).map((model) => ({
    value: model.id,
    label: model.name === model.id ? model.id : `${model.id}（${model.name}）`,
  }));
  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Alert
        type="info"
        showIcon
        message="只管模型目录付费档里的 Surplus 模型"
        description={
          <>
            畅聊候选、畅聊兜底、状态栏、长期记忆各有自己的设置，不受这里影响。Surplus
            只能指定到供应商，同一供应商下的卖家选不了；默认只派给可信供应商；
            {SURPLUS_ALWAYS_BLOCKED_PROVIDERS.join('、')} 已统一屏蔽。深度思考开关照常生效（开 =
            medium、关 = none），某家不认思考参数时自动停发 6
            小时。没填的项沿用统一默认：可靠优先、价格带 100%、不设折扣底线。
          </>
        }
      />
      {props.rules.map((rule, index) => (
        <SurplusRuleCard
          key={index}
          index={index}
          rule={rule}
          disabled={props.disabled}
          markets={markets}
          modelOptions={modelOptions}
          onChange={(patch) =>
            props.onChange(
              props.rules.map((item, i) => (i === index ? { ...item, ...patch } : item))
            )
          }
          onRemove={() => props.onChange(props.rules.filter((_, i) => i !== index))}
        />
      ))}
      <Button
        block
        disabled={props.disabled}
        onClick={() => props.onChange([...props.rules, { ...EMPTY_RULE }])}
      >
        添加 Surplus 规则
      </Button>
    </Space>
  );
}

function SurplusRuleCard(props: {
  index: number;
  rule: EditableSurplusRule;
  disabled?: boolean;
  markets: SurplusMarkets;
  modelOptions: ProviderOptions;
  onChange: (patch: Partial<EditableSurplusRule>) => void;
  onRemove: () => void;
}) {
  const { markets, rule } = props;
  const model = rule.surplus_model_id;
  const market = markets.market(model);
  const error = markets.error(model);
  const providerOptions = (market?.providers ?? []).map((row) => ({
    value: row.provider,
    label: providerOptionLabel(row),
  }));
  return (
    <Card
      size="small"
      title={model || `Surplus 规则 ${props.index + 1}（未选模型）`}
      extra={
        <Button danger size="small" disabled={props.disabled} onClick={props.onRemove}>
          删除
        </Button>
      }
    >
      <Row gutter={[12, 12]}>
        <Col xs={24}>
          <Typography.Text>模型（Surplus 模型名）</Typography.Text>
          <Space.Compact className="field-full">
            <AutoComplete
              className="field-full"
              value={model}
              options={props.modelOptions}
              disabled={props.disabled}
              placeholder="如 deepseek-v4.1-flash-1017"
              filterOption={(input, option) =>
                (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
              onChange={(value) => props.onChange({ surplus_model_id: value })}
            />
            <Button
              disabled={!markets.available || !model.trim()}
              loading={markets.loading(model)}
              onClick={() => void markets.load(model)}
            >
              {market ? '刷新报价' : '查看各家报价'}
            </Button>
          </Space.Compact>
        </Col>
        {error ? (
          <Col xs={24}>
            <Alert type="error" message={error} />
          </Col>
        ) : null}
        {market ? (
          <Col xs={24}>
            <MarketTable market={market} />
          </Col>
        ) : null}
        <ProviderListFields
          rule={rule}
          disabled={props.disabled}
          options={providerOptions}
          onChange={props.onChange}
        />
        <RoutePreferenceFields rule={rule} disabled={props.disabled} onChange={props.onChange} />
      </Row>
    </Card>
  );
}

function ProviderListFields(props: {
  rule: EditableSurplusRule;
  disabled?: boolean;
  options: ProviderOptions;
  onChange: (patch: Partial<EditableSurplusRule>) => void;
}) {
  const fields = [
    {
      key: 'allowed_providers',
      label: '只走这几家（其余一律不派，都没卖家时交给兜底）',
      placeholder: '留空 = 不限',
    },
    {
      key: 'preferred_providers',
      label: '优先这几家（只排序，其余照样能派）',
      placeholder: '如 mistral、deepseek',
    },
    { key: 'blocked_providers', label: '屏蔽这几家', placeholder: '如 inferhub' },
  ] as const;
  return (
    <>
      {fields.map((field) => (
        <Col key={field.key} xs={24} md={8}>
          <Typography.Text>{field.label}</Typography.Text>
          <ProviderSelect
            value={props.rule[field.key]}
            options={props.options}
            disabled={props.disabled}
            placeholder={field.placeholder}
            onChange={(value) => props.onChange({ [field.key]: value })}
          />
        </Col>
      ))}
    </>
  );
}

function RoutePreferenceFields(props: {
  rule: EditableSurplusRule;
  disabled?: boolean;
  onChange: (patch: Partial<EditableSurplusRule>) => void;
}) {
  const { rule } = props;
  return (
    <>
      <Col xs={24} md={8}>
        <Typography.Text>折扣底线 %（凑不到交给兜底）</Typography.Text>
        <InputNumber
          className="field-full"
          min={1}
          max={100}
          precision={0}
          value={rule.min_discount_pct}
          disabled={props.disabled}
          placeholder="留空 = 不设"
          onChange={(value) => props.onChange({ min_discount_pct: value ?? null })}
        />
      </Col>
      <Col xs={24} md={8}>
        <Typography.Text>派单方式</Typography.Text>
        <Select
          className="field-full"
          value={rule.route_objective ?? 'default'}
          disabled={props.disabled}
          options={[
            { value: 'default', label: '统一默认（可靠优先）' },
            { value: 'reliability', label: '可靠优先（按近期成功率）' },
            { value: 'latency', label: '首字优先（按实测首字）' },
          ]}
          onChange={(value: string) =>
            props.onChange({
              route_objective: value === 'latency' || value === 'reliability' ? value : null,
            })
          }
        />
      </Col>
      <Col xs={24} md={8}>
        <Typography.Text>价格带 %（比最便宜的贵多少以内按派单方式排）</Typography.Text>
        <InputNumber
          className="field-full"
          min={0}
          max={10_000}
          precision={0}
          value={rule.price_tolerance_pct}
          disabled={props.disabled}
          placeholder="留空 = 100"
          onChange={(value) => props.onChange({ price_tolerance_pct: value ?? null })}
        />
      </Col>
      <Col xs={24}>
        <Typography.Text>备注（依据 / 日期，供复盘）</Typography.Text>
        <Input
          value={rule.note}
          maxLength={200}
          disabled={props.disabled}
          placeholder="如：mistral 首字 p50 1.7s、折扣 85%，2026-11-27"
          onChange={(event) => props.onChange({ note: event.target.value })}
        />
      </Col>
    </>
  );
}
