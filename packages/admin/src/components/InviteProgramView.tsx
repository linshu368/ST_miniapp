import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { Dayjs } from 'dayjs';
import type { AdminEnvironment } from '../lib/environment';
import {
  configMetadata,
  INVITE_RULE_KEY_LABELS,
  type ManagedConfigKey,
} from '../lib/configSchemas';
import {
  INVITE_RECORDS_PAGE_SIZE,
  listInviteRecords,
  type InviteRecord,
  type InviteRecordFilters,
  type InviteRewardStatusFilter,
} from '../lib/inviteAdminApi';

/** 素材/规则/开关的编辑入口只在 config 视图一处，这里只做跳转说明卡，避免两处编辑同一 key。 */
const INVITE_CONFIG_KEYS = [
  'miniapp_invite_center_config',
  'miniapp_invite_reward_rules',
  'miniapp_invite_entry_enabled',
] as const satisfies readonly ManagedConfigKey[];

interface InviteProgramViewProps {
  client: SupabaseClient;
  environment: AdminEnvironment;
  onOpenConfig: (key: ManagedConfigKey) => void;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function describeUser(displayName: string | null, tgId: string | null): string {
  const name = displayName?.trim();
  if (name) return name;
  if (tgId) return `用户 ${tgId}`;
  return '—';
}

function RewardStatusTag(props: { total: number }) {
  // 本期实时发放，只有两个状态：有到账=已到账，零到账=未发放（无"待批量更新"态）。
  return props.total > 0 ? <Tag color="green">已到账</Tag> : <Tag>未发放</Tag>;
}

export function InviteProgramView(props: InviteProgramViewProps) {
  const [inviterInput, setInviterInput] = useState('');
  const [inviteeInput, setInviteeInput] = useState('');
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [statusInput, setStatusInput] = useState<'all' | InviteRewardStatusFilter>('all');

  const [appliedFilters, setAppliedFilters] = useState<InviteRecordFilters>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(INVITE_RECORDS_PAGE_SIZE);
  const [records, setRecords] = useState<InviteRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRecords = useCallback(
    async (filters: InviteRecordFilters, nextPage: number, nextPageSize: number) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listInviteRecords({
          client: props.client,
          filters,
          limit: nextPageSize,
          offset: (nextPage - 1) * nextPageSize,
        });
        setRecords(result.records);
        setTotal(result.total);
      } catch (caught) {
        setRecords([]);
        setTotal(0);
        setError(caught instanceof Error ? caught.message : '邀请数据查询失败');
      } finally {
        setLoading(false);
      }
    },
    [props.client]
  );

  // 首次进入与切换环境（client 随之变化）时载入最近明细。
  useEffect(() => {
    setInviterInput('');
    setInviteeInput('');
    setRange(null);
    setStatusInput('all');
    setAppliedFilters({});
    setPage(1);
    setPageSize(INVITE_RECORDS_PAGE_SIZE);
    void fetchRecords({}, 1, INVITE_RECORDS_PAGE_SIZE);
  }, [fetchRecords]);

  const runSearch = () => {
    const filters: InviteRecordFilters = {
      inviterRef: inviterInput.trim() || undefined,
      inviteeRef: inviteeInput.trim() || undefined,
      // RPC 的绑定时间是闭开区间 [from, to)：结束日 +1 天保证整天都被覆盖。
      boundFrom: range?.[0] ? range[0].startOf('day').toISOString() : undefined,
      boundTo: range?.[1] ? range[1].add(1, 'day').startOf('day').toISOString() : undefined,
      rewardStatus: statusInput === 'all' ? null : statusInput,
    };
    setAppliedFilters(filters);
    setPage(1);
    void fetchRecords(filters, 1, pageSize);
  };

  const resetSearch = () => {
    setInviterInput('');
    setInviteeInput('');
    setRange(null);
    setStatusInput('all');
    setAppliedFilters({});
    setPage(1);
    void fetchRecords({}, 1, pageSize);
  };

  const materialsTab = (
    <Space direction="vertical" size="middle" className="field-full">
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        素材、奖励规则与入口开关统一走「运营配置」的草稿 / 发布 /
        回滚流程，这里只做入口，避免同一配置出现两处编辑。
      </Typography.Paragraph>
      <Row gutter={[16, 16]}>
        {INVITE_CONFIG_KEYS.map((key) => (
          <Col xs={24} lg={8} key={key}>
            <Card
              size="small"
              title={configMetadata[key].label}
              extra={
                <Button type="link" size="small" onClick={() => props.onOpenConfig(key)}>
                  前往编辑
                </Button>
              }
            >
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {configMetadata[key].description}
              </Typography.Paragraph>
            </Card>
          </Col>
        ))}
      </Row>
    </Space>
  );

  const recordsTab = (
    <Space direction="vertical" size="middle" className="field-full">
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        按邀请人、被邀请用户、绑定时间或奖励状态查询邀请关系明细；不展示总邀请数或已发放星尘汇总。
      </Typography.Paragraph>

      <Row gutter={[12, 12]} align="bottom">
        <Col xs={24} md={12} lg={5}>
          <Typography.Text>邀请人</Typography.Text>
          <Input
            value={inviterInput}
            placeholder="用户 UUID 或 Telegram ID"
            allowClear
            onChange={(event) => setInviterInput(event.target.value)}
            onPressEnter={runSearch}
          />
        </Col>
        <Col xs={24} md={12} lg={5}>
          <Typography.Text>被邀请用户</Typography.Text>
          <Input
            value={inviteeInput}
            placeholder="用户 UUID 或 Telegram ID"
            allowClear
            onChange={(event) => setInviteeInput(event.target.value)}
            onPressEnter={runSearch}
          />
        </Col>
        <Col xs={24} md={12} lg={6}>
          <Typography.Text>绑定时间</Typography.Text>
          <DatePicker.RangePicker
            className="field-full"
            value={range}
            allowEmpty={[true, true]}
            onChange={(value) => setRange(value)}
          />
        </Col>
        <Col xs={24} md={12} lg={4}>
          <Typography.Text>奖励状态</Typography.Text>
          <Select
            className="field-full"
            value={statusInput}
            options={[
              { value: 'all', label: '全部奖励状态' },
              { value: 'granted', label: '已到账' },
              { value: 'none', label: '未发放' },
            ]}
            onChange={(value) => setStatusInput(value)}
          />
        </Col>
        <Col xs={24} lg={4}>
          <Space>
            <Button type="primary" loading={loading} onClick={runSearch}>
              查询
            </Button>
            <Button disabled={loading} onClick={resetSearch}>
              重置
            </Button>
          </Space>
        </Col>
      </Row>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Table<InviteRecord>
        rowKey="relation_id"
        size="middle"
        loading={loading}
        dataSource={records}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100, 200],
          showTotal: (count) => `共 ${count} 条`,
        }}
        onChange={(pagination) => {
          const nextPage = pagination.current ?? 1;
          const nextPageSize = pagination.pageSize ?? INVITE_RECORDS_PAGE_SIZE;
          setPage(nextPage);
          setPageSize(nextPageSize);
          void fetchRecords(appliedFilters, nextPage, nextPageSize);
        }}
        columns={[
          {
            title: '被邀请新用户',
            render: (_value, record) => (
              <>
                <Typography.Text>
                  {describeUser(record.invitee_display_name, record.invitee_tg_id)}
                </Typography.Text>
                <br />
                <Typography.Text type="secondary">TG {record.invitee_tg_id ?? '—'}</Typography.Text>
              </>
            ),
          },
          {
            title: '邀请人',
            render: (_value, record) => (
              <>
                <Typography.Text>
                  {describeUser(record.inviter_display_name, record.inviter_tg_id)}
                </Typography.Text>
                <br />
                <Typography.Text type="secondary">TG {record.inviter_tg_id ?? '—'}</Typography.Text>
              </>
            ),
          },
          {
            title: '绑定时间',
            dataIndex: 'bound_at',
            render: formatTime,
          },
          {
            title: '当前奖励状态',
            dataIndex: 'reward_credits_total',
            render: (value: number) => <RewardStatusTag total={value} />,
          },
          {
            title: '累计奖励',
            dataIndex: 'reward_credits_total',
            render: (value: number) => (value > 0 ? `${value.toLocaleString('zh-CN')} 星尘` : '—'),
          },
        ]}
        expandable={{
          expandedRowRender: (record) => (
            <Space direction="vertical" size="small" className="field-full">
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="邀请码">
                  <Typography.Text code>{record.invite_code}</Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="累计奖励">
                  {record.reward_credits_total.toLocaleString('zh-CN')} 星尘
                </Descriptions.Item>
                <Descriptions.Item label="邀请人 UUID">
                  <Typography.Text copyable>{record.inviter_user_id}</Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="被邀请用户 UUID">
                  <Typography.Text copyable>{record.invitee_user_id}</Typography.Text>
                </Descriptions.Item>
              </Descriptions>
              {record.reward_entries.length === 0 ? (
                <Typography.Text type="secondary">暂无奖励发放记录</Typography.Text>
              ) : (
                <Table<InviteRecord['reward_entries'][number]>
                  size="small"
                  rowKey={(entry) => `${entry.rule_key}-${entry.granted_at}`}
                  pagination={false}
                  dataSource={record.reward_entries}
                  columns={[
                    {
                      title: '奖励规则',
                      dataIndex: 'rule_key',
                      render: (ruleKey: string) => INVITE_RULE_KEY_LABELS[ruleKey] ?? ruleKey,
                    },
                    {
                      title: '星尘',
                      dataIndex: 'credits',
                      render: (credits: number) => <Tag color="green">+{credits}</Tag>,
                    },
                    {
                      title: '到账时间',
                      dataIndex: 'granted_at',
                      render: formatTime,
                    },
                  ]}
                />
              )}
            </Space>
          ),
        }}
      />
    </Space>
  );

  return (
    <Card title="裂变邀请管理">
      <Typography.Paragraph type="secondary">
        配置用户端的邀请海报与文案，并按邀请关系查询被邀请新用户与奖励状态。
        {props.environment === 'production' ? '当前处于生产环境。' : null}
      </Typography.Paragraph>
      <Tabs
        defaultActiveKey="materials"
        items={[
          { key: 'materials', label: '素材配置', children: materialsTab },
          { key: 'records', label: '邀请数据', children: recordsTab },
        ]}
      />
    </Card>
  );
}
