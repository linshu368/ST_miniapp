import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAnalyticsChatDetail,
  getAnalyticsDashboard,
  getAnalyticsUserDetail,
  listAnalyticsChats,
  listAnalyticsOutreachMessages,
  listAnalyticsUsers,
  type AnalyticsChat,
  type AnalyticsDashboard,
  type AnalyticsGrain,
  type AnalyticsOutreachMessage,
  type AnalyticsQuery,
  type AnalyticsRow,
  type AnalyticsUser,
} from '../../lib/analyticsApi';
import { analyticsSections, type AnalyticsSectionKey } from '../../lib/adminNavigation';
import { downloadAnalyticsCsv, stringifyAnalyticsValue } from '../../lib/analyticsExport';

const PAGE_SIZE = 50;
const AnalyticsPlot = lazy(() =>
  import('./AnalyticsPlot').then((module) => ({ default: module.AnalyticsPlot }))
);

function localDateInput(date: Date): string {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 10);
}

function dateRange(days: number): { fromDate: string; toDate: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  return { fromDate: localDateInput(from), toDate: localDateInput(to) };
}

function buildQuery(fromDate: string, toDate: string, grain: AnalyticsGrain): AnalyticsQuery {
  return {
    from: new Date(`${fromDate}T00:00:00`).toISOString(),
    to: new Date(`${toDate}T23:59:59.999`).toISOString(),
    grain,
  };
}

function formatDate(value: unknown): string {
  if (!value) return '-';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN');
}

function formatSummary(value: string | number | null, unit?: string): string {
  if (value === null || value === '') return '-';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  if (unit === '分')
    return `¥${(numeric / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
  return numeric.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
}

function renderCell(value: unknown) {
  if (typeof value === 'boolean') return value ? <Tag color="green">是</Tag> : <Tag>否</Tag>;
  if (value === null || value === undefined || value === '') return '-';
  const text = stringifyAnalyticsValue(value);
  return (
    <Typography.Text ellipsis={{ tooltip: text }} className="analytics-cell-text">
      {text}
    </Typography.Text>
  );
}

function GenericAnalyticsTable(props: { title: string; rows: AnalyticsRow[]; exportName: string }) {
  const columns = useMemo(
    () =>
      Array.from(new Set(props.rows.flatMap((row) => Object.keys(row)))).map((key) => ({
        title: key,
        dataIndex: key,
        key,
        render: renderCell,
      })),
    [props.rows]
  );
  return (
    <Card
      title={props.title}
      className="analytics-report-card"
      extra={
        <Button
          size="small"
          disabled={props.rows.length === 0}
          onClick={() => downloadAnalyticsCsv(`${props.exportName}.csv`, props.rows)}
        >
          导出 CSV
        </Button>
      }
    >
      {props.rows.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选范围暂无数据" />
      ) : (
        <Table
          rowKey={(_row, index) => String(index)}
          size="small"
          dataSource={props.rows}
          columns={columns}
          scroll={{ x: 'max-content' }}
          pagination={{ pageSize: 20, showSizeChanger: true }}
        />
      )}
    </Card>
  );
}

function JsonDrawer(props: { title: string; value: AnalyticsRow | null; onClose: () => void }) {
  return (
    <Drawer
      title={props.title}
      width="min(860px, 96vw)"
      open={Boolean(props.value)}
      onClose={props.onClose}
    >
      {props.value ? (
        <Space direction="vertical" size="middle" className="analytics-detail-list">
          {Object.entries(props.value).map(([key, value]) => (
            <div key={key}>
              <Typography.Text strong>{key}</Typography.Text>
              {typeof value === 'object' && value !== null ? (
                <pre className="analytics-json">{JSON.stringify(value, null, 2)}</pre>
              ) : (
                <Typography.Paragraph copyable>
                  {stringifyAnalyticsValue(value) || '-'}
                </Typography.Paragraph>
              )}
            </div>
          ))}
        </Space>
      ) : null}
    </Drawer>
  );
}

function Pager(props: {
  page: number;
  rowCount: number;
  loading: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <Space>
      <Button
        disabled={props.page <= 1 || props.loading}
        onClick={() => props.onPage(props.page - 1)}
      >
        上一页
      </Button>
      <Typography.Text>第 {props.page} 页</Typography.Text>
      <Button
        disabled={props.rowCount < PAGE_SIZE || props.loading}
        onClick={() => props.onPage(props.page + 1)}
      >
        下一页
      </Button>
    </Space>
  );
}

function UserExplorer(props: { client: SupabaseClient; canViewDetails: boolean }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AnalyticsUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AnalyticsRow | null>(null);

  const load = useCallback(async () => {
    if (!props.canViewDetails) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await listAnalyticsUsers(props.client, search, page, PAGE_SIZE));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '用户明细加载失败');
    } finally {
      setLoading(false);
    }
  }, [page, props.canViewDetails, props.client, search]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!props.canViewDetails) {
    return (
      <Alert
        showIcon
        type="info"
        message="viewer 账号只能查看聚合报表，用户身份与内容明细仅 owner/operator 可见。"
      />
    );
  }

  return (
    <Card
      title="用户明细与 360 视图"
      className="analytics-report-card"
      extra={
        <Button
          size="small"
          disabled={rows.length === 0}
          onClick={() => downloadAnalyticsCsv('用户明细.csv', rows as unknown as AnalyticsRow[])}
        >
          导出当前页
        </Button>
      }
    >
      <Space direction="vertical" className="analytics-full-width">
        <Input.Search
          allowClear
          placeholder="搜索 Telegram ID、用户名、显示名或用户 UUID"
          onSearch={(value) => {
            setSearch(value);
            setPage(1);
          }}
        />
        {error ? <Alert showIcon type="error" message={error} /> : null}
        <Table
          rowKey="user_id"
          size="small"
          loading={loading}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1100 }}
          columns={[
            { title: 'Telegram ID', dataIndex: 'tg_id' },
            { title: '用户名', dataIndex: 'tg_username', render: renderCell },
            { title: '显示名', dataIndex: 'display_name', render: renderCell },
            { title: '来源', dataIndex: 'source_id', render: renderCell },
            { title: '总轮数', dataIndex: 'total_round' },
            { title: '星尘余额', dataIndex: 'total_credits' },
            { title: '累计付费', dataIndex: 'total_paid_amount' },
            { title: '注册时间', dataIndex: 'created_at', render: formatDate },
            { title: '最后活跃', dataIndex: 'last_active_at', render: formatDate },
            {
              title: '操作',
              fixed: 'right',
              render: (_value, row) => (
                <Button
                  size="small"
                  onClick={async () =>
                    setDetail(await getAnalyticsUserDetail(props.client, row.user_id))
                  }
                >
                  用户 360
                </Button>
              ),
            },
          ]}
        />
        <Pager page={page} rowCount={rows.length} loading={loading} onPage={setPage} />
      </Space>
      <JsonDrawer title="用户 360 完整明细" value={detail} onClose={() => setDetail(null)} />
    </Card>
  );
}

function ChatExplorer(props: {
  client: SupabaseClient;
  query: AnalyticsQuery;
  canViewDetails: boolean;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AnalyticsChat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AnalyticsRow | null>(null);

  const load = useCallback(async () => {
    if (!props.canViewDetails) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await listAnalyticsChats(props.client, props.query, search, status, page, PAGE_SIZE));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '对话明细加载失败');
    } finally {
      setLoading(false);
    }
  }, [page, props.canViewDetails, props.client, props.query, search, status]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!props.canViewDetails) {
    return (
      <Alert
        showIcon
        type="info"
        message="viewer 账号不能读取用户输入、AI 回复与完整对话上下文。"
      />
    );
  }

  return (
    <Card
      title="完整对话明细"
      className="analytics-report-card"
      extra={
        <Button
          size="small"
          disabled={rows.length === 0}
          onClick={() => downloadAnalyticsCsv('对话明细.csv', rows as unknown as AnalyticsRow[])}
        >
          导出当前页
        </Button>
      }
    >
      <Space direction="vertical" className="analytics-full-width">
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="用户、模型或角色"
            className="analytics-search"
            onSearch={(value) => {
              setSearch(value);
              setPage(1);
            }}
          />
          <Select
            value={status}
            className="analytics-status-select"
            options={[
              { label: '全部状态', value: '' },
              { label: '成功', value: 'success' },
              { label: '上游错误', value: 'upstream_error' },
              { label: '流中断', value: 'stream_interrupted' },
            ]}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          />
        </Space>
        {error ? <Alert showIcon type="error" message={error} /> : null}
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1700 }}
          columns={[
            { title: '时间', dataIndex: 'created_at', render: formatDate, width: 170 },
            { title: 'Telegram ID', dataIndex: 'tg_id' },
            { title: '显示名', dataIndex: 'display_name', render: renderCell },
            { title: '角色', dataIndex: 'character_name', render: renderCell },
            { title: '模型', dataIndex: 'model' },
            { title: '供应商', dataIndex: 'provider', render: renderCell },
            { title: '状态', dataIndex: 'status' },
            { title: '扣费', dataIndex: 'deduction_rate' },
            { title: '用户输入', dataIndex: 'user_input_preview', render: renderCell, width: 260 },
            {
              title: 'AI 回复',
              dataIndex: 'assistant_reply_preview',
              render: renderCell,
              width: 260,
            },
            {
              title: '操作',
              fixed: 'right',
              render: (_value, row) => (
                <Button
                  size="small"
                  onClick={async () =>
                    setDetail(await getAnalyticsChatDetail(props.client, row.id))
                  }
                >
                  完整记录
                </Button>
              ),
            },
          ]}
        />
        <Pager page={page} rowCount={rows.length} loading={loading} onPage={setPage} />
      </Space>
      <JsonDrawer
        title="对话、History 与 LLM 完整数据"
        value={detail}
        onClose={() => setDetail(null)}
      />
    </Card>
  );
}

function OutreachExplorer(props: {
  client: SupabaseClient;
  query: AnalyticsQuery;
  canViewDetails: boolean;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AnalyticsOutreachMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!props.canViewDetails) return;
    setLoading(true);
    setError(null);
    try {
      setRows(
        await listAnalyticsOutreachMessages(
          props.client,
          props.query,
          search,
          status,
          page,
          PAGE_SIZE
        )
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '回访消息加载失败');
    } finally {
      setLoading(false);
    }
  }, [page, props.canViewDetails, props.client, props.query, search, status]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!props.canViewDetails) {
    return (
      <Alert showIcon type="info" message="viewer 账号不能读取客服消息原文和 Telegram 身份。" />
    );
  }

  return (
    <Card
      title="客服回访完整消息"
      className="analytics-report-card"
      extra={
        <Button
          size="small"
          disabled={rows.length === 0}
          onClick={() =>
            downloadAnalyticsCsv('客服回访消息.csv', rows as unknown as AnalyticsRow[])
          }
        >
          导出当前页
        </Button>
      }
    >
      <Space direction="vertical" className="analytics-full-width">
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="Telegram ID、人群或消息原文"
            className="analytics-search"
            onSearch={(value) => {
              setSearch(value);
              setPage(1);
            }}
          />
          <Select
            value={status}
            className="analytics-status-select"
            options={[
              { label: '全部状态', value: '' },
              { label: '已发送', value: 'sent' },
              { label: '发送失败', value: 'failed' },
              { label: '已收到', value: 'received' },
            ]}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          />
        </Space>
        {error ? <Alert showIcon type="error" message={error} /> : null}
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1500 }}
          columns={[
            { title: '时间', dataIndex: 'created_at', render: formatDate, width: 170 },
            { title: '人群', dataIndex: 'persona_name', render: renderCell },
            { title: 'Telegram ID', dataIndex: 'telegram_user_id' },
            { title: '方向', dataIndex: 'direction' },
            { title: 'SOP 阶段', dataIndex: 'sop_stage', render: renderCell },
            { title: '状态', dataIndex: 'send_status' },
            { title: '消息原文', dataIndex: 'content', render: renderCell, width: 420 },
            { title: '失败原因', dataIndex: 'failed_reason', render: renderCell, width: 260 },
            { title: '操作人', dataIndex: 'operator_id', render: renderCell },
          ]}
        />
        <Pager page={page} rowCount={rows.length} loading={loading} onPage={setPage} />
      </Space>
    </Card>
  );
}

export function AnalyticsView(props: {
  client: SupabaseClient;
  section: AnalyticsSectionKey;
  role: 'owner' | 'operator' | 'viewer';
}) {
  const initialRange = useMemo(() => dateRange(30), []);
  const [fromDate, setFromDate] = useState(initialRange.fromDate);
  const [toDate, setToDate] = useState(initialRange.toDate);
  const [grain, setGrain] = useState<AnalyticsGrain>('day');
  const [refreshToken, setRefreshToken] = useState(0);
  const [dashboard, setDashboard] = useState<AnalyticsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const query = useMemo(() => buildQuery(fromDate, toDate, grain), [fromDate, grain, toDate]);
  const sectionLabel =
    analyticsSections.find((section) => section.key === props.section)?.label ?? props.section;
  const canViewDetails = props.role !== 'viewer';

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getAnalyticsDashboard(props.client, props.section, query)
      .then((result) => {
        if (active) setDashboard(result);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : '数据分析加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.client, props.section, query, refreshToken]);

  const applyRange = (days: number) => {
    const range = dateRange(days);
    setFromDate(range.fromDate);
    setToDate(range.toDate);
  };

  return (
    <Space direction="vertical" size="middle" className="analytics-page">
      <Card>
        <div className="analytics-header">
          <div>
            <Typography.Title level={3}>{sectionLabel}</Typography.Title>
            <Typography.Text type="secondary">
              数据均来自当前所选数据库环境，生成时间：
              {dashboard ? formatDate(dashboard.generated_at) : '-'}
            </Typography.Text>
          </div>
          <Space wrap>
            <Button onClick={() => applyRange(7)}>近 7 天</Button>
            <Button onClick={() => applyRange(30)}>近 30 天</Button>
            <Button onClick={() => applyRange(90)}>近 90 天</Button>
            <label className="analytics-date-field">
              <span>开始</span>
              <input
                type="date"
                value={fromDate}
                max={toDate}
                onChange={(event) => setFromDate(event.target.value)}
              />
            </label>
            <label className="analytics-date-field">
              <span>结束</span>
              <input
                type="date"
                value={toDate}
                min={fromDate}
                onChange={(event) => setToDate(event.target.value)}
              />
            </label>
            <Select<AnalyticsGrain>
              value={grain}
              className="analytics-grain-select"
              options={[
                { label: '按小时', value: 'hour' },
                { label: '按日', value: 'day' },
                { label: '按周', value: 'week' },
                { label: '按月', value: 'month' },
              ]}
              onChange={setGrain}
            />
            <Button type="primary" onClick={() => setRefreshToken((value) => value + 1)}>
              刷新
            </Button>
          </Space>
        </div>
      </Card>

      {error ? <Alert type="error" showIcon message="报表加载失败" description={error} /> : null}
      {dashboard?.notes.map((note) => (
        <Alert key={note} type="warning" showIcon message={note} />
      ))}

      {loading && !dashboard ? (
        <div className="content-loading">
          <Spin />
        </div>
      ) : (
        <>
          <Row gutter={[12, 12]}>
            {(dashboard?.summary ?? []).map((item) => (
              <Col xs={12} md={8} xl={4} key={item.label}>
                <Card className="analytics-kpi-card">
                  <Statistic
                    title={item.label}
                    value={formatSummary(item.value, item.unit)}
                    suffix={item.unit === '分' ? undefined : item.unit}
                  />
                </Card>
              </Col>
            ))}
          </Row>

          <Row gutter={[16, 16]}>
            {(dashboard?.charts ?? []).map((chart) => (
              <Col xs={24} xl={12} key={chart.title}>
                <Card title={chart.title} className="analytics-report-card">
                  {chart.data.length === 0 ? (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="当前筛选范围暂无趋势数据"
                    />
                  ) : (
                    <Suspense
                      fallback={
                        <div className="content-loading">
                          <Spin />
                        </div>
                      }
                    >
                      <AnalyticsPlot chart={chart} />
                    </Suspense>
                  )}
                </Card>
              </Col>
            ))}
          </Row>

          {(dashboard?.tables ?? []).map((table, index) => (
            <GenericAnalyticsTable
              key={`${table.title}-${index}`}
              title={table.title}
              rows={table.rows}
              exportName={`${sectionLabel}-${table.title}`}
            />
          ))}

          {props.section === 'users' ? (
            <UserExplorer client={props.client} canViewDetails={canViewDetails} />
          ) : null}
          {props.section === 'chats' ? (
            <ChatExplorer client={props.client} query={query} canViewDetails={canViewDetails} />
          ) : null}
          {props.section === 'outreach' ? (
            <OutreachExplorer client={props.client} query={query} canViewDetails={canViewDetails} />
          ) : null}
        </>
      )}
    </Space>
  );
}
