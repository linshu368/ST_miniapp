import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
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
  getLlmUsageChargeDetail,
  listAnalyticsChats,
  listLlmUsageCharges,
  listAnalyticsOutreachMessages,
  listAnalyticsUsers,
  type AnalyticsChat,
  type AnalyticsDashboard,
  type AnalyticsGrain,
  type AnalyticsOutreachMessage,
  type AnalyticsQuery,
  type AnalyticsRow,
  type AnalyticsUsageCharge,
  type AnalyticsUsageChargeFilters,
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
  total?: number;
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
        disabled={
          props.loading ||
          (props.total === undefined
            ? props.rowCount < PAGE_SIZE
            : props.page * PAGE_SIZE >= props.total)
        }
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

function chargeStatusTag(status: string) {
  const labels: Record<string, { label: string; color: string }> = {
    pending: { label: '待结算', color: 'gold' },
    failed: { label: '生成失败（未扣费）', color: 'red' },
    free: { label: '免费', color: 'green' },
    charged: { label: '已扣费', color: 'blue' },
    reconciled: { label: '已对账', color: 'cyan' },
    partial: { label: '部分扣费', color: 'orange' },
    historical: { label: '历史记录', color: 'default' },
  };
  const item = labels[status];
  return <Tag color={item?.color}>{item?.label ?? status}</Tag>;
}

function formatDecimal(value: unknown, maximumFractionDigits = 6): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('zh-CN', { maximumFractionDigits }) : '-';
}

function SpendingDetailDrawer(props: {
  row: AnalyticsUsageCharge | null;
  detail: AnalyticsRow | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const value = props.detail ?? props.row;
  const ledgerEntries = props.detail?.ledger_entries;
  const rawMetadata = value && 'metadata' in value ? value.metadata : null;
  const metadata =
    rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : null;
  return (
    <Drawer
      title="星尘消耗详情"
      width="min(900px, 96vw)"
      open={Boolean(props.row)}
      onClose={props.onClose}
    >
      {props.error ? <Alert showIcon type="error" message={props.error} /> : null}
      <Spin spinning={props.loading}>
        {value ? (
          <Space direction="vertical" size="middle" className="analytics-full-width">
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="扣费记录 ID">{renderCell(value.id)}</Descriptions.Item>
              <Descriptions.Item label="扣费幂等键">
                {renderCell(value.charge_key)}
              </Descriptions.Item>
              <Descriptions.Item label="用户">
                {renderCell(value.display_name)} / Telegram {renderCell(value.tg_id)} /{' '}
                {renderCell(value.user_id)}
              </Descriptions.Item>
              <Descriptions.Item label="模型">
                {renderCell(value.model_display_name)}（{renderCell(value.model_openrouter_id)}）
              </Descriptions.Item>
              <Descriptions.Item label="配置版本">
                模型目录 v{formatDecimal(value.catalog_version, 0)} / 计费配置 v
                {formatDecimal(value.pricing_config_version, 0)}
              </Descriptions.Item>
              <Descriptions.Item label="上游成本">
                ${formatDecimal(value.usage_cost_usd, 10)}
              </Descriptions.Item>
              <Descriptions.Item label="汇率">
                {formatDecimal(value.exchange_rate)}
              </Descriptions.Item>
              <Descriptions.Item label="倍率">
                {Number(value.model_markup) === 0
                  ? '0 倍（免费）'
                  : `${formatDecimal(value.model_markup)} 倍`}
              </Descriptions.Item>
              <Descriptions.Item label="计算公式">
                {metadata?.billing_mode === 'fixed_tier'
                  ? `固定档位 ${formatDecimal(metadata.fixed_deduction ?? value.calculated_amount)} = ${formatDecimal(value.calculated_amount)} 星尘`
                  : String(value.status) === 'failed'
                    ? '免费模型生成失败，本次实扣 0.0 星尘'
                    : String(value.status) === 'pending'
                      ? '等待 OpenRouter 返回最终用量，当前实扣 0.0 星尘'
                      : value.fallback_used
                        ? `历史 Fallback ${formatDecimal(metadata?.fallback_cost ?? value.initial_amount)} = ${formatDecimal(value.calculated_amount)} 星尘`
                        : `$${formatDecimal(value.usage_cost_usd, 10)} × ${formatDecimal(value.exchange_rate)} × ${formatDecimal(value.model_markup)} = ${formatDecimal(value.calculated_amount)} 星尘`}
              </Descriptions.Item>
              <Descriptions.Item label="初始 / 计算 / 实扣">
                {formatDecimal(value.initial_amount)} / {formatDecimal(value.calculated_amount)} /{' '}
                {formatDecimal(value.charged_amount)} 星尘
              </Descriptions.Item>
              <Descriptions.Item label="成本来源">
                {metadata?.billing_mode === 'fixed_tier' ? (
                  Number(value.calculated_amount) === 0 ? (
                    <Tag color="green">免费额度</Tag>
                  ) : (
                    <Tag color="blue">固定档位</Tag>
                  )
                ) : String(value.status) === 'failed' ? (
                  <Tag color="red">生成失败</Tag>
                ) : String(value.status) === 'pending' ? (
                  <Tag color="gold">等待最终用量</Tag>
                ) : value.fallback_used ? (
                  <Tag color="orange">历史 Fallback</Tag>
                ) : Number(value.model_markup) === 0 ? (
                  <Tag color="green">免费模型</Tag>
                ) : (
                  <Tag>实际用量</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="对账状态">
                {chargeStatusTag(String(value.status))}
                {value.reconciled_at ? ` ${formatDate(value.reconciled_at)}` : ''}
              </Descriptions.Item>
              <Descriptions.Item label="账本引用">
                {renderCell(value.debit_ledger_id)}
              </Descriptions.Item>
              <Descriptions.Item label="差额原因">
                {renderCell(metadata?.difference_reason)}
              </Descriptions.Item>
            </Descriptions>
            <div>
              <Typography.Text strong>关联账本流水</Typography.Text>
              <pre className="analytics-json">
                {JSON.stringify(Array.isArray(ledgerEntries) ? ledgerEntries : [], null, 2)}
              </pre>
            </div>
          </Space>
        ) : null}
      </Spin>
    </Drawer>
  );
}

function SpendingExplorer(props: {
  client: SupabaseClient;
  query: AnalyticsQuery;
  canViewDetails: boolean;
}) {
  const [filters, setFilters] = useState<AnalyticsUsageChargeFilters>({
    search: '',
    model: '',
    fallback: null,
    status: '',
  });
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AnalyticsUsageCharge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AnalyticsUsageCharge | null>(null);
  const [detail, setDetail] = useState<AnalyticsRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const total = Number(rows[0]?.total_count ?? 0);

  const updateFilters = (patch: Partial<AnalyticsUsageChargeFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };

  const load = useCallback(async () => {
    if (!props.canViewDetails) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await listLlmUsageCharges(props.client, props.query, filters, page, PAGE_SIZE));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '星尘消耗明细加载失败');
    } finally {
      setLoading(false);
    }
  }, [filters, page, props.canViewDetails, props.client, props.query]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!props.canViewDetails) {
    return <Alert showIcon type="info" message="viewer 账号不能读取用户级星尘消耗明细。" />;
  }

  return (
    <Card
      title="星尘消耗记录"
      className="analytics-report-card"
      extra={
        <Button
          size="small"
          disabled={rows.length === 0}
          onClick={() =>
            downloadAnalyticsCsv('星尘消耗明细.csv', rows as unknown as AnalyticsRow[])
          }
        >
          导出当前页 CSV
        </Button>
      }
    >
      <Space direction="vertical" className="analytics-full-width">
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="用户、Telegram ID 或扣费 ID"
            className="analytics-search"
            onSearch={(search) => updateFilters({ search })}
          />
          <Input.Search
            allowClear
            placeholder="模型 ID（精确匹配）"
            className="analytics-model-search"
            onSearch={(model) => updateFilters({ model })}
          />
          <Select
            value={filters.fallback === null ? 'all' : filters.fallback ? 'fallback' : 'actual'}
            className="analytics-status-select"
            options={[
              { label: '全部成本来源', value: 'all' },
              { label: '实际用量', value: 'actual' },
              { label: '历史 Fallback', value: 'fallback' },
            ]}
            onChange={(value) =>
              updateFilters({ fallback: value === 'all' ? null : value === 'fallback' })
            }
          />
          <Select
            value={filters.status}
            className="analytics-status-select"
            options={[
              { label: '全部对账状态', value: '' },
              { label: '待结算', value: 'pending' },
              { label: '生成失败（未扣费）', value: 'failed' },
              { label: '免费', value: 'free' },
              { label: '已扣费', value: 'charged' },
              { label: '已对账', value: 'reconciled' },
              { label: '部分扣费', value: 'partial' },
              { label: '历史记录', value: 'historical' },
            ]}
            onChange={(status) => updateFilters({ status })}
          />
        </Space>
        {error ? <Alert showIcon type="error" message={error} /> : null}
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1800 }}
          columns={[
            { title: '时间', dataIndex: 'created_at', render: formatDate, width: 170 },
            {
              title: '用户',
              width: 180,
              render: (_value, row) => row.display_name || row.tg_id || row.user_id,
            },
            { title: '模型', dataIndex: 'model_display_name', width: 180 },
            { title: 'OpenRouter ID', dataIndex: 'model_openrouter_id', width: 230 },
            {
              title: 'USD 成本',
              dataIndex: 'usage_cost_usd',
              render: (value) => `$${formatDecimal(value, 10)}`,
            },
            {
              title: '汇率',
              dataIndex: 'exchange_rate',
              render: (value) => formatDecimal(value),
            },
            {
              title: '倍率',
              dataIndex: 'model_markup',
              render: (value) =>
                Number(value) === 0 ? <Tag color="green">0 倍（免费）</Tag> : `${value} 倍`,
            },
            {
              title: '计算星尘',
              dataIndex: 'calculated_amount',
              render: (value) => formatDecimal(value),
            },
            {
              title: '实扣星尘',
              dataIndex: 'charged_amount',
              render: (value) => formatDecimal(value),
            },
            {
              title: '成本来源',
              dataIndex: 'fallback_used',
              render: (value, row) =>
                row.status === 'failed' ? (
                  <Tag color="red">生成失败</Tag>
                ) : row.status === 'pending' ? (
                  <Tag color="gold">等待用量</Tag>
                ) : value ? (
                  <Tag color="orange">历史 Fallback</Tag>
                ) : row.model_markup === 0 || Number(row.calculated_amount) === 0 ? (
                  <Tag color="green">免费</Tag>
                ) : (
                  <Tag color="blue">固定档位</Tag>
                ),
            },
            { title: '状态', dataIndex: 'status', render: chargeStatusTag },
            {
              title: '操作',
              fixed: 'right',
              render: (_value, row) => (
                <Button
                  size="small"
                  onClick={async () => {
                    setSelected(row);
                    setDetail(null);
                    setDetailError(null);
                    setDetailLoading(true);
                    try {
                      setDetail(await getLlmUsageChargeDetail(props.client, row.id));
                    } catch (loadError) {
                      setDetailError(
                        loadError instanceof Error ? loadError.message : '扣费详情加载失败'
                      );
                    } finally {
                      setDetailLoading(false);
                    }
                  }}
                >
                  查看详情
                </Button>
              ),
            },
          ]}
        />
        <Space>
          <Pager
            page={page}
            rowCount={rows.length}
            total={total}
            loading={loading}
            onPage={setPage}
          />
          <Typography.Text type="secondary">共 {total.toLocaleString('zh-CN')} 条</Typography.Text>
        </Space>
      </Space>
      <SpendingDetailDrawer
        row={selected}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        onClose={() => {
          setSelected(null);
          setDetail(null);
          setDetailError(null);
        }}
      />
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
    if (props.section === 'spending') {
      setDashboard(null);
      setError(null);
      setLoading(false);
      return;
    }
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
          {props.section === 'spending' ? (
            <SpendingExplorer client={props.client} query={query} canViewDetails={canViewDetails} />
          ) : null}
        </>
      )}
    </Space>
  );
}
