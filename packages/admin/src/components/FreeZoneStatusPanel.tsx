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
  FREE_ZONE_STATUS_LABELS,
  fetchFreeZoneStatus,
  freeZoneReasonView,
} from '@miniapp/admin-client';
import type {
  AdminFreeZoneEvent,
  AdminFreeZoneStatusModel,
  AdminFreeZoneStatusResponse,
} from '@miniapp/shared';
import { useAdminApi } from '../lib/adminApiContext';

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
    return `用 ${model.providers.join('、')}，${time(model.provider_since)} 起`;
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

function columns(requiredPasses: number): TableColumnsType<AdminFreeZoneStatusModel> {
  return [
    {
      title: '候选',
      key: 'name',
      width: 220,
      render: (_, model) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text>
            {model.display_name ?? model.candidate_id}
            {model.in_config ? null : <Tag style={{ marginLeft: 6 }}>已不在候选池</Tag>}
          </Typography.Text>
          <Typography.Text type="secondary">{model.surplus_model}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 90,
      render: (_, model) =>
        model.status ? (
          <Tag color={STATUS_COLORS[model.status]}>{FREE_ZONE_STATUS_LABELS[model.status]}</Tag>
        ) : (
          <Tag>未评估</Tag>
        ),
    },
    {
      title: '详情',
      key: 'detail',
      width: 220,
      render: (_, model) => detail(model, requiredPasses),
    },
    {
      title: '最近原因',
      key: 'reason',
      render: (_, model) => {
        const excluded = Object.entries(model.excluded_providers);
        return (
          <Space orientation="vertical" size={4}>
            <ReasonCell model={model} />
            {excluded.length ? (
              <Typography.Text type="warning">
                排除中：{excluded.map(([name, until]) => `${name}（到 ${time(until)}）`).join('、')}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
  ];
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

/** 评估任务落库的线上状态：哪些在架（用户能选）、哪些在攒连续达标、哪些在冷却。 */
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
  const count = (status: keyof typeof FREE_ZONE_STATUS_LABELS) =>
    data?.models.filter((model) => model.status === status).length ?? 0;

  return (
    <Space orientation="vertical" size="small" className="editor-stack">
      <Space wrap>
        <Button size="small" loading={loading} onClick={() => void load()}>
          刷新
        </Button>
        {data ? (
          <>
            <Tag color="green">在架 {count('listed')}</Tag>
            <Tag>未上架 {count('unlisted')}</Tag>
            <Tag color="orange">冷却中 {count('cooling')}</Tag>
            <Typography.Text type="secondary">
              按已发布的配置；最近评估 {time(data.last_evaluated_at)}，每 30 分钟一次。
              {data.enabled ? '' : '总开关关着，用户看不到栏目。'}
            </Typography.Text>
          </>
        ) : null}
      </Space>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {data ? (
        <>
          <Table<AdminFreeZoneStatusModel>
            size="small"
            rowKey="candidate_id"
            pagination={false}
            scroll={{ x: 760 }}
            columns={columns(data.required_passes)}
            dataSource={data.models}
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
