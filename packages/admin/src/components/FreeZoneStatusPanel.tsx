import { useCallback, useEffect, useState } from 'react';
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
import {
  FREE_ZONE_STATUS_GROUPS,
  FREE_ZONE_STATUS_LABELS,
  fetchFreeZoneStatus,
  freeZoneProbeText,
  freeZoneReasonView,
  freeZoneStatusGroup,
  type FreeZoneStatusGroup,
} from '@miniapp/admin-client';
import type {
  AdminFreeZoneEvent,
  AdminFreeZoneStatusModel,
  AdminFreeZoneStatusResponse,
} from '@miniapp/shared';
import { useAdminApi } from '../lib/adminApiContext';
import { FreeZoneListNowButton } from './FreeZoneListNowButton';

const STATUS_COLORS = { listed: 'green', unlisted: 'default', cooling: 'orange' } as const;

const EVENT_LABELS: Record<AdminFreeZoneEvent['event_type'], string> = {
  listed: '上架',
  provider_switched: '换供应商',
  delisted: '下架',
  cooldown_ended: '冷却结束',
};

function time(iso: string | null): string {
  return iso ? dayjs(iso).format('M月D日 HH:mm') : '—';
}

function detail(model: AdminFreeZoneStatusModel, requiredPasses: number): string {
  if (model.status === 'listed') {
    const probe = freeZoneProbeText(model);
    return `用 ${model.providers.join('、')}，${time(model.provider_since)} 起${probe ? `；${probe}` : ''}`;
  }
  if (model.status === 'cooling') return `冷却到 ${time(model.cooldown_until)}`;
  if (model.status === 'unlisted') return `连续达标 ${model.consecutive_passes}/${requiredPasses}`;
  return '等下一轮评估';
}

/** 没过的项标红排前面、过了的标灰；悬停看原始原因全文。 */
function ReasonCell(props: { model: AdminFreeZoneStatusModel }) {
  const view = freeZoneReasonView(props.model);
  if (view.kind === 'none') return <Typography.Text type="secondary">—</Typography.Text>;
  if (view.kind === 'text') return <Typography.Text type="secondary">{view.text}</Typography.Text>;
  return (
    <Tooltip title={props.model.last_reason ?? undefined}>
      <Space orientation="vertical" size={2}>
        <Space wrap size={[4, 4]}>
          {view.tags.map((tag) => (
            <Tooltip key={tag.text} title={tag.hint}>
              <Tag
                color={tag.failed ? 'red' : undefined}
                variant={tag.failed ? 'outlined' : 'filled'}
              >
                {tag.failed ? '✗ ' : '✓ '}
                {tag.text}
              </Tag>
            </Tooltip>
          ))}
        </Space>
        {view.note ? <Typography.Text type="danger">{view.note}</Typography.Text> : null}
      </Space>
    </Tooltip>
  );
}

function NameCell(props: { model: AdminFreeZoneStatusModel; group: FreeZoneStatusGroup }) {
  const { model } = props;
  return (
    <Space orientation="vertical" size={0}>
      <Typography.Text>
        {model.display_name ?? model.candidate_id}
        {model.in_config ? null : <Tag style={{ marginLeft: 6 }}>已不在候选池</Tag>}
        {props.group === 'not_listed' && model.ever_listed ? (
          <Tooltip
            title={model.last_delist ? `${time(model.last_delist.at)} 因官方数据下架` : undefined}
          >
            <Tag style={{ marginLeft: 6 }}>曾上架</Tag>
          </Tooltip>
        ) : null}
      </Typography.Text>
      <Typography.Text type="secondary">{model.surplus_model}</Typography.Text>
    </Space>
  );
}

function ExcludedProviders(props: { model: AdminFreeZoneStatusModel }) {
  const excluded = Object.entries(props.model.excluded_providers);
  if (excluded.length === 0) return null;
  return (
    <Typography.Text type="warning">
      排除中：{excluded.map(([name, until]) => `${name}（到 ${time(until)}）`).join('、')}
    </Typography.Text>
  );
}

/** 三块共用一套列：在架的不显示状态和原因；业务下架的多一列下架原因。 */
function columns(
  requiredPasses: number,
  group: FreeZoneStatusGroup
): TableColumnsType<AdminFreeZoneStatusModel> {
  const name = {
    title: '候选',
    key: 'name',
    width: 220,
    render: (_: unknown, model: AdminFreeZoneStatusModel) => (
      <NameCell model={model} group={group} />
    ),
  };
  const detailColumn = {
    title: '详情',
    key: 'detail',
    width: 220,
    render: (_: unknown, model: AdminFreeZoneStatusModel) => detail(model, requiredPasses),
  };
  if (group === 'listed') {
    return [
      name,
      detailColumn,
      {
        title: '排除中的供应商',
        key: 'excluded',
        render: (_, model) =>
          Object.keys(model.excluded_providers).length > 0 ? (
            <ExcludedProviders model={model} />
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          ),
      },
    ];
  }
  const status = {
    title: '状态',
    key: 'status',
    width: 90,
    render: (_: unknown, model: AdminFreeZoneStatusModel) =>
      model.status ? (
        <Tag color={STATUS_COLORS[model.status]}>{FREE_ZONE_STATUS_LABELS[model.status]}</Tag>
      ) : (
        <Tag>未评估</Tag>
      ),
  };
  const reason = {
    title: '最近原因',
    key: 'reason',
    render: (_: unknown, model: AdminFreeZoneStatusModel) => (
      <Space orientation="vertical" size={4}>
        <ReasonCell model={model} />
        <ExcludedProviders model={model} />
      </Space>
    ),
  };
  if (group === 'not_listed') return [name, status, detailColumn, reason];
  return [
    name,
    status,
    detailColumn,
    {
      title: '下架原因',
      key: 'delist',
      width: 240,
      render: (_, model) =>
        model.last_delist ? (
          <Space orientation="vertical" size={0}>
            <Typography.Text type="secondary">{time(model.last_delist.at)}</Typography.Text>
            <Typography.Text type="danger">{model.last_delist.reason ?? '—'}</Typography.Text>
          </Space>
        ) : (
          '—'
        ),
    },
    reason,
  ];
}

function GroupTable(props: {
  data: AdminFreeZoneStatusResponse;
  group: FreeZoneStatusGroup;
  models: AdminFreeZoneStatusModel[];
  onChanged: () => void;
}) {
  if (props.models.length === 0) {
    return <Typography.Text type="secondary">暂无。</Typography.Text>;
  }
  const base = columns(props.data.required_passes, props.group);
  const action = {
    title: '操作',
    key: 'action',
    width: 100,
    render: (_: unknown, model: AdminFreeZoneStatusModel) => (
      <FreeZoneListNowButton model={model} onListed={props.onChanged} />
    ),
  };
  return (
    <Table<AdminFreeZoneStatusModel>
      size="small"
      rowKey="candidate_id"
      pagination={false}
      scroll={{ x: 860 }}
      columns={props.group === 'listed' ? base : [...base, action]}
      dataSource={props.models}
    />
  );
}

function EventList(props: { data: AdminFreeZoneStatusResponse }) {
  const names = new Map(
    props.data.models.map((model) => [model.candidate_id, model.display_name ?? model.candidate_id])
  );
  if (props.data.events.length === 0) {
    return <Typography.Text type="secondary">还没有上下架记录。</Typography.Text>;
  }
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {props.data.events.map((event) => (
        <li key={`${event.candidate_id}-${event.created_at}-${event.event_type}`}>
          <Typography.Text type="secondary">{time(event.created_at)}</Typography.Text>{' '}
          <Tag>{EVENT_LABELS[event.event_type]}</Tag>
          {names.get(event.candidate_id) ?? event.candidate_id}
          {event.providers.length ? `（${event.providers.join('、')}）` : ''}
          {event.reason ? (
            <Typography.Text type="secondary">：{event.reason}</Typography.Text>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** 评估任务落库的线上状态，分三块：在架、未上架、因业务数据下架；每块可折叠。 */
export function FreeZoneStatusPanel() {
  const api = useAdminApi();
  const [data, setData] = useState<AdminFreeZoneStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchFreeZoneStatus(api.client, api.apiUrl()));
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取失败');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!api) return <Typography.Text type="secondary">当前页面拿不到后端地址。</Typography.Text>;
  const grouped = new Map<FreeZoneStatusGroup, AdminFreeZoneStatusModel[]>(
    FREE_ZONE_STATUS_GROUPS.map((group) => [group.key, []])
  );
  for (const model of data?.models ?? []) grouped.get(freeZoneStatusGroup(model))?.push(model);
  // 默认展开在架的；业务下架的有内容才展开；未上架的模型多，默认收起
  const defaultOpen: FreeZoneStatusGroup[] = [
    'listed',
    ...((grouped.get('business_delisted')?.length ?? 0) > 0
      ? (['business_delisted'] as const)
      : []),
  ];

  return (
    <Space orientation="vertical" size="small" className="editor-stack">
      <Space wrap>
        <Button size="small" loading={loading} onClick={() => void load()}>
          刷新
        </Button>
        {data ? (
          <Typography.Text type="secondary">
            按已发布的配置；最近评估 {time(data.last_evaluated_at)}，每 30 分钟一次。
            {data.enabled ? '' : '总开关关着，用户看不到栏目。'}
          </Typography.Text>
        ) : null}
      </Space>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {data ? (
        <>
          <Collapse
            size="small"
            defaultActiveKey={defaultOpen}
            items={FREE_ZONE_STATUS_GROUPS.map((group) => ({
              key: group.key,
              label: (
                <Space size={6}>
                  <Typography.Text strong>
                    {group.label}（{grouped.get(group.key)?.length ?? 0}）
                  </Typography.Text>
                  <Typography.Text type="secondary">{group.hint}</Typography.Text>
                </Space>
              ),
              children: (
                <GroupTable
                  data={data}
                  group={group.key}
                  models={grouped.get(group.key) ?? []}
                  onChanged={() => void load()}
                />
              ),
            }))}
          />
          <Collapse
            size="small"
            items={[
              {
                key: 'events',
                label: `最近上下架记录（${data.events.length}）`,
                children: <EventList data={data} />,
              },
            ]}
          />
        </>
      ) : null}
    </Space>
  );
}
