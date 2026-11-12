import { useState } from 'react';
import dayjs from 'dayjs';
import {
  Alert,
  Button,
  Collapse,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableColumnsType,
} from 'antd';
import { FREE_ZONE_CHECK_LABELS, screenFreeZoneCandidates } from '@miniapp/admin-client';
import type {
  AdminFreeZoneModelResult,
  AdminFreeZoneProviderResult,
  AdminFreeZoneScreeningRequest,
  AdminFreeZoneScreeningResponse,
  FreeZoneConfig,
  FreeZoneScreeningCheck,
  FreeZoneScreeningCheckKey,
} from '@miniapp/shared';
import { useAdminApi } from '../lib/adminApiContext';
import { formatCheckValue, formatPricePer1m, screeningRequestFrom } from '../lib/freeZoneForm';

/** 供应商层逐项检查（表格列的顺序）。 */
const PROVIDER_KEYS: readonly FreeZoneScreeningCheckKey[] = [
  'min_qualified_offers',
  'min_samples',
  'min_uptime_pct',
  'max_ttft_p50_ms',
  'max_ttft_p90_ms',
  'min_tps',
  'min_cache_hit_rate_pct',
];

const MIN_KEYS = new Set<FreeZoneScreeningCheckKey>([
  'min_qualified_offers',
  'min_samples',
  'min_uptime_pct',
  'min_tps',
  'min_cache_hit_rate_pct',
  'min_realized_discount_pct',
]);

interface Run {
  key: string;
  request: AdminFreeZoneScreeningRequest;
  data: AdminFreeZoneScreeningResponse;
}

function thresholdText(key: FreeZoneScreeningCheckKey, request: AdminFreeZoneScreeningRequest) {
  // 派单探测只在评估任务里做，筛选预览没有这一列
  if (key === 'probe') return '评估时探测';
  const value = request.screening?.[key];
  if (value === null || value === undefined) return '不检查';
  return `${MIN_KEYS.has(key) ? '≥' : '≤'} ${formatCheckValue(key, value)}`;
}

function CheckCell(props: { check: FreeZoneScreeningCheck | undefined }) {
  const check = props.check;
  if (!check) return <Typography.Text type="secondary">—</Typography.Text>;
  const text = formatCheckValue(check.key, check.value);
  if (check.pass === null) return <Typography.Text type="secondary">{text}</Typography.Text>;
  return check.pass ? <span>{text}</span> : <Typography.Text type="danger">{text}</Typography.Text>;
}

function header(key: FreeZoneScreeningCheckKey, request: AdminFreeZoneScreeningRequest) {
  return (
    <Space orientation="vertical" size={0}>
      <span>{FREE_ZONE_CHECK_LABELS[key]}</span>
      <Typography.Text type="secondary">{thresholdText(key, request)}</Typography.Text>
    </Space>
  );
}

function providerColumns(
  request: AdminFreeZoneScreeningRequest
): TableColumnsType<AdminFreeZoneProviderResult> {
  return [
    {
      title: '供应商',
      key: 'provider',
      width: 130,
      render: (_, row) => (
        <Space size={4}>
          {row.provider}
          {row.qualified ? <Tag color="green">达标</Tag> : null}
        </Space>
      ),
    },
    {
      title: '价格/百万',
      key: 'price',
      width: 90,
      render: (_, row) => formatPricePer1m(row.price_per_1m),
    },
    ...PROVIDER_KEYS.map((key) => ({
      title: header(key, request),
      key,
      width: 100,
      render: (_: unknown, row: AdminFreeZoneProviderResult) => (
        <CheckCell check={row.checks.find((item) => item.key === key)} />
      ),
    })),
  ];
}

/** 一个模型在某一项上「有几家供应商过了」：看哪一项是这个模型的瓶颈。 */
function passCount(model: AdminFreeZoneModelResult, key: FreeZoneScreeningCheckKey) {
  if (model.error) return <Typography.Text type="secondary">—</Typography.Text>;
  const checks = model.providers.flatMap((row) => row.checks.filter((item) => item.key === key));
  if (checks.length === 0) return <Typography.Text type="danger">0 家</Typography.Text>;
  if (checks[0]?.pass === null) return <Typography.Text type="secondary">不检查</Typography.Text>;
  const passed = checks.filter((item) => item.pass).length;
  const text = `${passed}/${checks.length} 家`;
  return passed === 0 ? (
    <Typography.Text type="danger">{text}</Typography.Text>
  ) : (
    <span>{text}</span>
  );
}

function modelColumns(
  request: AdminFreeZoneScreeningRequest
): TableColumnsType<AdminFreeZoneModelResult> {
  return [
    {
      title: '候选',
      key: 'name',
      width: 190,
      fixed: 'left',
      render: (_, model) => (
        <Space orientation="vertical" size={0}>
          <span>{model.display_name}</span>
          <Typography.Text type="secondary">{model.surplus_model}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '结果',
      key: 'pass',
      width: 110,
      render: (_, model) =>
        model.error ? (
          <Tooltip title={model.error}>
            <Tag>行情没拿到</Tag>
          </Tooltip>
        ) : model.pass ? (
          <Tag color="green">达标 · {model.picked_provider}</Tag>
        ) : (
          <Tag color="red">不达标</Tag>
        ),
    },
    {
      title: header('min_realized_discount_pct', request),
      key: 'realized',
      width: 110,
      render: (_, model) => <CheckCell check={model.model_checks[0]} />,
    },
    ...PROVIDER_KEYS.map((key) => ({
      title: header(key, request),
      key,
      width: 100,
      render: (_: unknown, model: AdminFreeZoneModelResult) => passCount(model, key),
    })),
  ];
}

function Impact(props: { data: AdminFreeZoneScreeningResponse }) {
  const names = new Map(props.data.models.map((model) => [model.candidate_id, model.display_name]));
  const helpful = props.data.impact.filter((item) => item.unlocks.length > 0);
  if (helpful.length === 0) {
    return (
      <Typography.Text type="secondary">单独放开任何一项，都不会多出达标的模型。</Typography.Text>
    );
  }
  return (
    <Space wrap size={[4, 4]}>
      <Typography.Text type="secondary">
        只放开这一项（改成不检查；达标报价数按降到 1 家算），能多达标：
      </Typography.Text>
      {helpful.map((item) => (
        <Tooltip key={item.key} title={item.unlocks.map((id) => names.get(id) ?? id).join('、')}>
          <Tag color="blue">
            {FREE_ZONE_CHECK_LABELS[item.key]} +{item.unlocks.length}
          </Tag>
        </Tooltip>
      ))}
    </Space>
  );
}

function ResultTable(props: {
  request: AdminFreeZoneScreeningRequest;
  models: AdminFreeZoneModelResult[];
}) {
  return (
    <Table<AdminFreeZoneModelResult>
      size="small"
      rowKey="candidate_id"
      pagination={false}
      scroll={{ x: 1110 }}
      columns={modelColumns(props.request)}
      dataSource={props.models}
      expandable={{
        rowExpandable: (model) => model.providers.length > 0,
        expandedRowRender: (model) => (
          <Table<AdminFreeZoneProviderResult>
            size="small"
            rowKey="provider"
            pagination={false}
            columns={providerColumns(props.request)}
            dataSource={model.providers}
          />
        ),
      }}
    />
  );
}

/**
 * 「按当前门槛筛选」：用页面上的门槛（不用先保存）拿 Surplus 实时行情过一遍候选池。
 * 只读，不影响评估任务；Surplus 行情在后端缓存 1 分钟，改门槛再点很快。
 */
export function FreeZoneScreeningPanel(props: { config: FreeZoneConfig }) {
  const api = useAdminApi();
  const request = screeningRequestFrom(props.config);
  const requestKey = JSON.stringify(request);
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const screen = async () => {
    if (!api || !request) return;
    setLoading(true);
    setError(null);
    try {
      const data = await screenFreeZoneCandidates(api.client, api.apiUrl(), request);
      setRun({ key: requestKey, request, data });
    } catch (err) {
      setError(err instanceof Error ? err.message : '筛选失败');
    } finally {
      setLoading(false);
    }
  };

  const passed = run?.data.models.filter((model) => model.pass).length ?? 0;
  return (
    <Space orientation="vertical" size="small" className="editor-stack">
      <Space wrap>
        <Button type="primary" ghost loading={loading} disabled={!api || !request} onClick={screen}>
          按当前门槛筛选
        </Button>
        <Typography.Text type="secondary">
          {request
            ? '用页面上的门槛（不用先保存），实时拿 Surplus 行情过一遍候选池；不会上架或下架任何模型。'
            : '先把门槛和候选的模型名填对才能筛选。'}
        </Typography.Text>
      </Space>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {run ? (
        <>
          <Alert
            type={run.key === requestKey ? 'info' : 'warning'}
            showIcon
            title={`${run.data.models.length} 个候选，${passed} 个达标（${dayjs(run.data.checked_at).format('HH:mm:ss')}）${
              run.key === requestKey ? '' : '。门槛或候选改过了，再点一次看新结果'
            }`}
          />
          <Impact data={run.data} />
          <Collapse
            size="small"
            defaultActiveKey={['pass']}
            items={[
              {
                key: 'pass',
                label: `达标（${passed}）`,
                models: run.data.models.filter((m) => m.pass),
              },
              {
                key: 'fail',
                label: `不达标（${run.data.models.length - passed}）`,
                models: run.data.models.filter((m) => !m.pass),
              },
            ].map((group) => ({
              key: group.key,
              label: group.label,
              children: group.models.length ? (
                <ResultTable request={run.request} models={group.models} />
              ) : (
                <Typography.Text type="secondary">暂无。</Typography.Text>
              ),
            }))}
          />
          <Typography.Text type="secondary">
            每列是「这一项有几家 trusted
            供应商过了」；展开一行看每家的实际数值，红色是没过。一家供应商要每一项都过才算达标，模型还要过
            7 天成交折扣。
          </Typography.Text>
        </>
      ) : null}
    </Space>
  );
}
