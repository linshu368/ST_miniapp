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
  fetchFreeZoneStatus,
  freeZoneDelistText,
  type FreeZoneStatusGroup,
} from '@miniapp/admin-client';
import type {
  AdminFreeZoneEvent,
  AdminFreeZoneStatusModel,
  AdminFreeZoneStatusResponse,
} from '@miniapp/shared';
import { useAdminApi } from '../lib/adminApiContext';
import { FreeZoneDelistNowButton } from './FreeZoneDelistNowButton';
import { FreeZoneListNowButton } from './FreeZoneListNowButton';
import { FreeZonePinButton } from './FreeZonePinButton';
import {
  DISCOUNT_HINT,
  FreeZoneDirectPrice,
  FreeZoneDiscountInput,
  FreeZoneParallelInput,
  FreeZoneRouteInput,
  FreeZoneTurnLimitInput,
  PARALLEL_HINT,
  ROUTE_HINT,
  TURN_LIMIT_HINT,
  type FreeZoneCandidateEditing,
} from './FreeZoneCandidateInputs';

const EVENT_LABELS: Record<AdminFreeZoneEvent['event_type'], string> = {
  listed: '上架',
  delisted: '下架',
  // 下面两种只出现在旧机制留下的记录里
  provider_switched: '换供应商',
  cooldown_ended: '冷却结束',
};

function time(iso: string | null): string {
  return iso ? dayjs(iso).format('M月D日 HH:mm') : '—';
}

function detail(model: AdminFreeZoneStatusModel): string {
  if (model.status === 'listed') {
    return `用 ${model.providers.join('、')}，${time(model.provider_since)} 起`;
  }
  if (!model.last_delist) return model.ever_listed ? '—' : '没上过架';
  return `${time(model.last_delist.at)} 下架：${freeZoneDelistText(model) || '—'}`;
}

function NameCell(props: { model: AdminFreeZoneStatusModel }) {
  const { model } = props;
  return (
    <Space orientation="vertical" size={0}>
      <Typography.Text>
        {model.display_name ?? model.candidate_id}
        {model.pinned ? (
          <Tag color="gold" style={{ marginLeft: 6 }}>
            保上
          </Tag>
        ) : null}
        {model.in_config ? null : <Tag style={{ marginLeft: 6 }}>已不在候选池</Tag>}
      </Typography.Text>
      <Typography.Text type="secondary">{model.surplus_model}</Typography.Text>
    </Space>
  );
}

const BASE_COLUMNS: TableColumnsType<AdminFreeZoneStatusModel> = [
  {
    title: '候选',
    key: 'name',
    width: 220,
    render: (_: unknown, model: AdminFreeZoneStatusModel) => <NameCell model={model} />,
  },
  {
    title: '详情',
    key: 'detail',
    render: (_: unknown, model: AdminFreeZoneStatusModel) => detail(model),
  },
];

function GroupTable(props: {
  group: FreeZoneStatusGroup;
  models: AdminFreeZoneStatusModel[];
  onChanged: () => void;
  editing?: FreeZoneCandidateEditing;
}) {
  if (props.models.length === 0) {
    return <Typography.Text type="secondary">暂无。</Typography.Text>;
  }
  const action = {
    title: '操作',
    key: 'action',
    width: 160,
    render: (_: unknown, model: AdminFreeZoneStatusModel) => (
      <Space size={4}>
        {props.group === 'listed' ? (
          <FreeZoneDelistNowButton model={model} onDelisted={props.onChanged} />
        ) : (
          <FreeZoneListNowButton model={model} onListed={props.onChanged} />
        )}
        <FreeZonePinButton model={model} onChanged={props.onChanged} />
      </Space>
    ),
  };
  const price = {
    title: (
      <Tooltip title="Surplus 标的原价（直购参考价，多为 OpenRouter 价），折扣相对它算。输入 / 输出，每百万 token；上架选供应商时更新，悬停看按折扣底线的最高价。">
        <span>原价（入/出）</span>
      </Tooltip>
    ),
    key: 'price',
    width: 120,
    render: (_: unknown, model: AdminFreeZoneStatusModel) => (
      <FreeZoneDirectPrice model={model} editing={props.editing} />
    ),
  };
  const discount = {
    title: (
      <Tooltip title={DISCOUNT_HINT}>
        <span>折扣底线</span>
      </Tooltip>
    ),
    key: 'discount',
    width: 100,
    render: (_: unknown, model: AdminFreeZoneStatusModel) => (
      <FreeZoneDiscountInput model={model} editing={props.editing} />
    ),
  };
  const parallel = {
    title: (
      <Tooltip title={PARALLEL_HINT}>
        <span>并发</span>
      </Tooltip>
    ),
    key: 'parallel',
    width: 80,
    render: (_: unknown, model: AdminFreeZoneStatusModel) => (
      <FreeZoneParallelInput model={model} editing={props.editing} />
    ),
  };
  const route = {
    title: (
      <Tooltip title={ROUTE_HINT}>
        <span>派单</span>
      </Tooltip>
    ),
    key: 'route',
    width: 120,
    render: (_: unknown, model: AdminFreeZoneStatusModel) => (
      <FreeZoneRouteInput model={model} editing={props.editing} />
    ),
  };
  const limit = {
    title: (
      <Tooltip title={TURN_LIMIT_HINT}>
        <span>每天上限</span>
      </Tooltip>
    ),
    key: 'turn_limit',
    width: 100,
    render: (_: unknown, model: AdminFreeZoneStatusModel) => (
      <FreeZoneTurnLimitInput model={model} editing={props.editing} />
    ),
  };
  return (
    <Table<AdminFreeZoneStatusModel>
      size="small"
      rowKey="candidate_id"
      pagination={false}
      scroll={{ x: 1000 }}
      columns={
        props.group === 'listed'
          ? [...BASE_COLUMNS, price, discount, route, parallel, limit, action]
          : [...BASE_COLUMNS, price, discount, limit, action]
      }
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

/** 线上状态，分两块：在架、未上架；未上架的模型多，默认收起。 */
export function FreeZoneStatusPanel(props: { editing?: FreeZoneCandidateEditing }) {
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
  for (const model of data?.models ?? []) grouped.get(model.status)?.push(model);

  return (
    <Space orientation="vertical" size="small" className="editor-stack">
      <Space wrap>
        <Button size="small" loading={loading} onClick={() => void load()}>
          刷新
        </Button>
        {data ? (
          <Typography.Text type="secondary">
            按已发布的配置。「折扣底线」「并发」改完要保存并发布配置才生效。
            {data.enabled ? '' : '总开关关着，用户看不到栏目。'}
          </Typography.Text>
        ) : null}
      </Space>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {data ? (
        <>
          <Collapse
            size="small"
            defaultActiveKey={['listed']}
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
                  group={group.key}
                  models={grouped.get(group.key) ?? []}
                  onChanged={() => void load()}
                  editing={props.editing}
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
