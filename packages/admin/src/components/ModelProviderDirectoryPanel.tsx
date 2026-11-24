import { Alert, Button, Input, Space, Table, Tag, Typography } from 'antd';

import {
  LLM_MODEL_PROVIDER_LABELS,
  type LlmModelProvider,
  type ProviderModelDirectory,
  type ProviderModelSummary,
} from '@miniapp/shared';

import { formatUsdPerMillion, filterProviderModels } from './model-catalog-helpers';
import { RelayProviderBalance } from './RelayProviderBalance';
export function renderProviderDirectoryPanel(input: {
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
        <RelayProviderBalance provider={input.provider} />
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
            <ModelDirectoryTable
              models={filteredModels}
              tableKey={`${input.provider}:${input.search}`}
              label={label}
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

function ModelDirectoryTable({
  models,
  tableKey,
  label,
}: {
  models: ProviderModelSummary[];
  tableKey: string;
  label: string;
}) {
  return (
    <Table<ProviderModelSummary>
      key={tableKey}
      rowKey="id"
      size="small"
      dataSource={models}
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
          render: (value: number | null) => `${formatUsdPerMillion(value)} / 1M tokens`,
        },
        {
          title: 'Output',
          dataIndex: 'completion_usd_per_token',
          width: 135,
          render: (value: number | null) => `${formatUsdPerMillion(value)} / 1M tokens`,
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
  );
}
