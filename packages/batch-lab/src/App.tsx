import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BatchLabContext,
  BatchLabExperimentSummary,
  BatchLabExperimentVariant,
  BatchLabPreview,
  BatchLabProcessorVersion,
  BatchLabSampleSet,
  BatchLabSqlTemplate,
} from '@miniapp/shared';
import {
  BATCH_LAB_DEFAULT_SAMPLE_LIMIT,
  BATCH_LAB_MAX_EXPERIMENT_TURNS,
  BATCH_LAB_MAX_SAMPLE_LIMIT,
} from '@miniapp/shared';
import type { TableProps } from 'antd';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Progress,
  Result,
  Select,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Tabs,
  Typography,
  message,
} from 'antd';
import {
  copyBatchLabExperiment,
  createBatchLabExperiment,
  createBatchLabPreview,
  createBatchLabProcessor,
  createBatchLabReuseDisplayExperiment,
  createBatchLabSampleSet,
  downloadBatchLabExperimentJsonl,
  getBatchLabContext,
  getBatchLabExperiment,
  listBatchLabExperiments,
  listBatchLabProcessors,
  listBatchLabSampleSets,
  listBatchLabSqlTemplates,
  previewBatchLabProcessor,
  runBatchLabWorkerOnce,
  startBatchLabExperiment,
  upsertBatchLabAnnotation,
} from './api/client';
import { batchLabQueryKeys } from './api/query-keys';
import {
  buildProcessorConfig,
  displayStatusText,
  experimentProgress,
  experimentStatusText,
  newIdempotencyKey,
  parseSampling,
  parseSqlParameters,
  processorConfigToRulesJson,
  processorOptionLabel,
  variantDiffRows,
} from './lib/workbench';

const { Header, Content } = Layout;

type PageKey = 'experiments' | 'samples' | 'processors' | 'new';

type ExperimentFormValues = {
  name: string;
  sample_set_id: string;
  max_turns: number;
  variants: Array<{
    name: string;
    model_id: string;
    openrouter_model_id: string;
    tier: 'light' | 'standard' | 'premium' | null;
    is_free: boolean;
    sampling: string;
    processor_version_id: string | null;
  }>;
};

type ProcessorFormValues = {
  name: string;
  protocol: 'none_v1' | 'regex_json_v1';
  rules_json: string;
  input_text: string;
};

type SampleFormValues = {
  name: string;
  template_key: string | null;
  sample_limit: number;
  parameters_json: string;
  sql: string;
};

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

function makeVariant(
  values: ExperimentFormValues,
  index: 0 | 1,
  key: 'a' | 'b'
): BatchLabExperimentVariant {
  const variant = values.variants[index];
  return {
    key,
    name: variant.name,
    model_id: variant.model_id,
    openrouter_model_id: variant.openrouter_model_id,
    tier: variant.tier,
    is_free: variant.is_free,
    sampling: parseSampling(variant.sampling),
    processor_version_id: variant.processor_version_id,
    max_turns: values.max_turns,
  };
}

function CapabilityBanner({ context }: { context: BatchLabContext }) {
  const missing = [
    context.capabilities.sample_preview ? null : '样本预览',
    context.capabilities.experiment_execution ? null : '实验执行',
  ].filter(Boolean);

  return (
    <Alert
      className="env-banner"
      type={context.source_environment === 'production' ? 'warning' : 'info'}
      showIcon
      message={
        <Space wrap>
          <strong>权威环境</strong>
          <Tag>Backend: {context.backend_environment}</Tag>
          <Tag color={context.source_environment === 'production' ? 'red' : 'blue'}>
            样本来源: {context.source_environment}
          </Tag>
          {missing.length > 0 ? <Tag color="orange">未开放: {missing.join('、')}</Tag> : null}
        </Space>
      }
      description="来源环境由 Backend 部署固定，缓存和任务均按此环境隔离。"
    />
  );
}

function useWorkbenchData(context: BatchLabContext) {
  const templates = useQuery({
    queryKey: batchLabQueryKeys.templates(context),
    queryFn: ({ signal }) => listBatchLabSqlTemplates(signal),
  });
  const sampleSets = useQuery({
    queryKey: batchLabQueryKeys.sampleSets(context),
    queryFn: ({ signal }) => listBatchLabSampleSets(signal),
  });
  const processors = useQuery({
    queryKey: batchLabQueryKeys.processors(context),
    queryFn: ({ signal }) => listBatchLabProcessors(signal),
  });
  const experiments = useQuery({
    queryKey: batchLabQueryKeys.experiments(context),
    queryFn: ({ signal }) => listBatchLabExperiments(signal),
    refetchInterval: (query) => {
      const items = query.state.data ?? [];
      return items.some((item) => item.status === 'queued' || item.status === 'running')
        ? 5_000
        : false;
    },
  });
  return { templates, sampleSets, processors, experiments };
}

export function App() {
  const [page, setPage] = useState<PageKey>('new');
  const contextQuery = useQuery({
    queryKey: batchLabQueryKeys.context,
    queryFn: ({ signal }) => getBatchLabContext(signal),
    retry: false,
    staleTime: 60_000,
  });

  if (contextQuery.isPending) return <Skeleton active style={{ padding: 32 }} />;
  if (contextQuery.isError) {
    return (
      <Result
        status="error"
        title="无法确认运行环境"
        subTitle="Batch Lab 已安全停止。请检查 Backend feature flag、来源环境和 API/CORS 配置。"
      />
    );
  }

  return <WorkbenchShell context={contextQuery.data} page={page} onPageChange={setPage} />;
}

function WorkbenchShell({
  context,
  page,
  onPageChange,
}: {
  context: BatchLabContext;
  page: PageKey;
  onPageChange: (page: PageKey) => void;
}) {
  const data = useWorkbenchData(context);
  const anyError = [data.templates, data.sampleSets, data.processors, data.experiments].find(
    (query) => query.isError
  );

  return (
    <Layout className="app-layout">
      <Header className="app-header">
        <Typography.Title level={3} className="app-title">
          TURN / LAB
        </Typography.Title>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[page]}
          onClick={(item) => onPageChange(item.key as PageKey)}
          items={[
            { key: 'experiments', label: '实验记录' },
            { key: 'samples', label: '样本集' },
            { key: 'processors', label: '富文本后处理' },
            { key: 'new', label: '新建实验' },
          ]}
        />
      </Header>
      <Content className="app-content">
        <CapabilityBanner context={context} />
        {anyError ? (
          <Alert
            className="section-gap"
            type="error"
            showIcon
            message="数据加载失败"
            description={errorMessage(anyError.error)}
          />
        ) : null}
        {page === 'experiments' ? (
          <ExperimentsPage context={context} experiments={data.experiments.data ?? []} />
        ) : null}
        {page === 'samples' ? (
          <SamplesPage
            context={context}
            templates={data.templates.data ?? []}
            sampleSets={data.sampleSets.data ?? []}
            loading={data.templates.isPending || data.sampleSets.isPending}
          />
        ) : null}
        {page === 'processors' ? (
          <ProcessorsPage
            processors={data.processors.data ?? []}
            loading={data.processors.isPending}
          />
        ) : null}
        {page === 'new' ? (
          <ExperimentWizard
            context={context}
            sampleSets={data.sampleSets.data ?? []}
            processors={data.processors.data ?? []}
            loading={data.sampleSets.isPending || data.processors.isPending}
            onCreated={() => onPageChange('experiments')}
          />
        ) : null}
      </Content>
    </Layout>
  );
}

function ExperimentsPage({
  context,
  experiments,
}: {
  context: BatchLabContext;
  experiments: BatchLabExperimentSummary[];
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<BatchLabExperimentSummary | null>(null);
  const invalidateExperiments = () =>
    queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.experiments(context) });
  const startMutation = useMutation({
    mutationFn: (experiment: BatchLabExperimentSummary) =>
      startBatchLabExperiment({
        experiment_id: experiment.id,
        source_environment: context.source_environment,
        idempotency_key: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      message.success('实验已进入队列');
      await invalidateExperiments();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const workerMutation = useMutation({
    mutationFn: () =>
      runBatchLabWorkerOnce({
        source_environment: context.source_environment,
        worker_id: `batch-lab-ui-${Date.now()}`,
        claim_limit: 5,
      }),
    onSuccess: async (result) => {
      message.success(`领取 ${result.claimed_count}，完成 ${result.completed_count}`);
      await invalidateExperiments();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const columns: TableProps<BatchLabExperimentSummary>['columns'] = [
    {
      title: '实验',
      dataIndex: 'name',
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Button type="link" className="link-button" onClick={() => setSelected(record)}>
            {record.name}
          </Button>
          <Typography.Text type="secondary">{record.id}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (_, record) => (
        <Space direction="vertical" size={4} className="full-width">
          <Space>
            <Tag
              color={
                record.status === 'failed'
                  ? 'red'
                  : record.status === 'completed'
                    ? 'green'
                    : 'blue'
              }
            >
              {experimentStatusText(record.status)}
            </Tag>
            <Typography.Text type="secondary">
              {record.completed_attempts}/{record.total_attempts}
            </Typography.Text>
          </Space>
          <Progress
            percent={experimentProgress(record)}
            size="small"
            status={record.failed_attempts ? 'exception' : 'active'}
          />
        </Space>
      ),
    },
    {
      title: '失败',
      dataIndex: 'failed_attempts',
      width: 90,
    },
    {
      title: '创建',
      dataIndex: 'created_at',
      render: (value: string) => formatDate(value),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, record) => (
        <Space wrap>
          <Button onClick={() => setSelected(record)}>查看</Button>
          <Button
            type="primary"
            disabled={record.status !== 'draft' || !context.capabilities.experiment_execution}
            loading={startMutation.isPending}
            onClick={() => startMutation.mutate(record)}
          >
            启动
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <section className="section-gap">
      <div className="page-head">
        <div>
          <Typography.Title level={2}>实验记录</Typography.Title>
          <Typography.Text type="secondary">
            按后端持久状态恢复进度，刷新页面不会丢失运行记录。
          </Typography.Text>
        </div>
        <Button loading={workerMutation.isPending} onClick={() => workerMutation.mutate()}>
          Worker run-once
        </Button>
      </div>
      <Table
        rowKey="id"
        className="work-table"
        columns={columns}
        dataSource={experiments}
        locale={{ emptyText: '暂无实验，先创建并启动一个 A/B 组合。' }}
        scroll={{ x: 840 }}
      />
      <ExperimentDrawer context={context} experiment={selected} onClose={() => setSelected(null)} />
    </section>
  );
}

function ExperimentDrawer({
  context,
  experiment,
  onClose,
}: {
  context: BatchLabContext;
  experiment: BatchLabExperimentSummary | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: experiment
      ? batchLabQueryKeys.experiment(context, experiment.id)
      : [...batchLabQueryKeys.experiments(context), 'none'],
    queryFn: ({ signal }) => getBatchLabExperiment(experiment?.id ?? '', signal),
    enabled: experiment !== null,
  });
  const detail = detailQuery.data;
  const variants = detail?.variants ?? experiment?.variants ?? [];
  const diffRows = variants.length >= 2 ? variantDiffRows(variants[0], variants[1]) : [];
  const invalidateExperiments = async () => {
    await queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.experiments(context) });
    if (experiment) {
      await queryClient.invalidateQueries({
        queryKey: batchLabQueryKeys.experiment(context, experiment.id),
      });
    }
  };
  const copyMutation = useMutation({
    mutationFn: () => {
      if (!experiment) throw new Error('请选择实验');
      return copyBatchLabExperiment({
        source_experiment_id: experiment.id,
        name: `${experiment.name} · 副本`,
        source_environment: context.source_environment,
        idempotency_key: newIdempotencyKey(),
      });
    },
    onSuccess: async () => {
      message.success('已复制为新草稿');
      await invalidateExperiments();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const reuseMutation = useMutation({
    mutationFn: () => {
      if (!detail) throw new Error('详情尚未加载');
      return createBatchLabReuseDisplayExperiment({
        source_experiment_id: detail.id,
        name: `${detail.name} · 复用原文`,
        source_environment: context.source_environment,
        variants: detail.variants.map((variant) => ({ ...variant })),
        idempotency_key: newIdempotencyKey(),
      });
    },
    onSuccess: async () => {
      message.success('已保存复用原文实验');
      await invalidateExperiments();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const annotationMutation = useMutation({
    mutationFn: (note: string) => {
      if (!experiment) throw new Error('请选择实验');
      return upsertBatchLabAnnotation({
        experiment_id: experiment.id,
        sample_ordinal: null,
        turn_index: null,
        tag: null,
        note,
        source_environment: context.source_environment,
      });
    },
    onSuccess: () => message.success('备注已保存'),
    onError: (error) => message.error(errorMessage(error)),
  });
  const exportMutation = useMutation({
    mutationFn: async () => {
      if (!experiment) throw new Error('请选择实验');
      const blob = await downloadBatchLabExperimentJsonl(experiment.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `batch-lab-${experiment.id}.jsonl`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  return (
    <Drawer width={720} title={experiment?.name} open={experiment !== null} onClose={onClose}>
      {experiment ? (
        <Space direction="vertical" size={20} className="full-width">
          <Space wrap>
            <Button loading={copyMutation.isPending} onClick={() => copyMutation.mutate()}>
              复制为草稿
            </Button>
            <Button
              disabled={!detail}
              loading={reuseMutation.isPending}
              onClick={() => reuseMutation.mutate()}
            >
              复用原文
            </Button>
            <Button loading={exportMutation.isPending} onClick={() => exportMutation.mutate()}>
              导出 JSONL
            </Button>
          </Space>
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="状态">
              {experimentStatusText(detail?.status ?? experiment.status)}
            </Descriptions.Item>
            <Descriptions.Item label="样本集">
              {detail?.sample_set_id ?? experiment.sample_set_id}
            </Descriptions.Item>
            <Descriptions.Item label="来源环境">
              {detail?.source_environment ?? experiment.source_environment}
            </Descriptions.Item>
            <Descriptions.Item label="血缘">
              {detail ? (
                <Space direction="vertical" size={2}>
                  <Typography.Text>{detail.lineage.kind}</Typography.Text>
                  <Typography.Text type="secondary">
                    source: {detail.lineage.source_experiment_id ?? '-'}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    generation: {detail.lineage.generation_source_experiment_id ?? '-'}
                  </Typography.Text>
                </Space>
              ) : (
                '加载中'
              )}
            </Descriptions.Item>
            <Descriptions.Item label="进度">
              {experiment.completed_attempts} 成功 / {experiment.failed_attempts} 失败 /{' '}
              {experiment.total_attempts} 总任务
            </Descriptions.Item>
          </Descriptions>
          <Card title="A/B 完整组合差异" size="small">
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={diffRows}
              columns={[
                { title: '字段', dataIndex: 'label', width: 140 },
                { title: '基准 A', dataIndex: 'baseline' },
                {
                  title: '候选 B',
                  dataIndex: 'candidate',
                  render: (value, row) => (
                    <Typography.Text type={row.baseline === value ? 'secondary' : undefined}>
                      {value}
                    </Typography.Text>
                  ),
                },
              ]}
              scroll={{ x: 640 }}
            />
          </Card>
          <Alert
            type="info"
            showIcon
            message="逐样本逐轮事实通过 JSONL 恢复"
            description="详情抽屉展示冻结配置、血缘和操作入口；全量样本/轮次事实通过导出按行恢复，避免一次性把大正文塞进列表响应。"
          />
          <Card title="实验备注" size="small">
            <Input.TextArea id="experiment-note" rows={4} placeholder="记录观察，不参与评分。" />
            <Button
              className="section-gap"
              loading={annotationMutation.isPending}
              onClick={() => {
                const element = document.getElementById('experiment-note');
                annotationMutation.mutate(
                  element instanceof HTMLTextAreaElement ? element.value : ''
                );
              }}
            >
              保存备注
            </Button>
          </Card>
        </Space>
      ) : null}
    </Drawer>
  );
}

function SamplesPage({
  context,
  templates,
  sampleSets,
  loading,
}: {
  context: BatchLabContext;
  templates: BatchLabSqlTemplate[];
  sampleSets: BatchLabSampleSet[];
  loading: boolean;
}) {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<SampleFormValues>();
  const [preview, setPreview] = useState<BatchLabPreview | null>(null);
  const defaultTemplate = templates[0];

  const templateOptions = templates.map((template) => ({
    value: `${template.key}:${template.version}`,
    label: `${template.name} · v${template.version}`,
  }));

  const previewMutation = useMutation({
    mutationFn: (values: SampleFormValues) => {
      const template =
        values.template_key === null
          ? null
          : (templates.find((item) => `${item.key}:${item.version}` === values.template_key) ??
            null);
      return createBatchLabPreview({
        source_environment: context.source_environment,
        template_key: template?.key ?? null,
        template_version: template?.version ?? null,
        sql: values.sql,
        parameters: parseSqlParameters(values.parameters_json),
        sample_limit: values.sample_limit,
      });
    },
    onSuccess: (value) => setPreview(value),
    onError: (error) => message.error(errorMessage(error)),
  });

  const saveMutation = useMutation({
    mutationFn: (values: SampleFormValues) => {
      if (!preview) throw new Error('请先预览并确认样本');
      return createBatchLabSampleSet({
        name: values.name,
        preview_id: preview.id,
        preview_digest: preview.digest,
        source_environment: context.source_environment,
        idempotency_key: newIdempotencyKey(),
      });
    },
    onSuccess: async () => {
      message.success('样本集已冻结');
      setPreview(null);
      await queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.sampleSets(context) });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const applyTemplate = (value: string | null) => {
    const template = templates.find((item) => `${item.key}:${item.version}` === value);
    if (!template) return;
    form.setFieldsValue({
      sql: template.sql,
      parameters_json: JSON.stringify(template.default_parameters, null, 2),
    });
    setPreview(null);
  };

  return (
    <section className="section-gap">
      <div className="page-head">
        <div>
          <Typography.Title level={2}>样本集</Typography.Title>
          <Typography.Text type="secondary">
            SQL 预览确认后冻结，后续实验复用同一批快照。
          </Typography.Text>
        </div>
      </div>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={sampleSets}
        scroll={{ x: 820 }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          {
            title: '规模',
            render: (_, record) => (
              <Space>
                <Tag>{record.sample_count} 条</Tag>
                <Typography.Text type="secondary">
                  {record.statistics.user_count} 用户 / {record.statistics.character_count} 角色
                </Typography.Text>
              </Space>
            ),
          },
          { title: '来源', dataIndex: 'source_environment', width: 100 },
          { title: '创建', dataIndex: 'created_at', render: (value: string) => formatDate(value) },
        ]}
        locale={{ emptyText: '暂无冻结样本集。' }}
      />
      <Card className="section-gap" title="创建样本集">
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            name: '长对话 · 新建调试集',
            template_key: defaultTemplate
              ? `${defaultTemplate.key}:${defaultTemplate.version}`
              : null,
            sample_limit: BATCH_LAB_DEFAULT_SAMPLE_LIMIT,
            parameters_json: JSON.stringify(defaultTemplate?.default_parameters ?? {}, null, 2),
            sql: defaultTemplate?.sql ?? 'SELECT * FROM turn_samples LIMIT {{sample_count}};',
          }}
          onValuesChange={() => setPreview(null)}
          onFinish={(values) => previewMutation.mutate(values)}
        >
          <div className="form-grid three">
            <Form.Item name="name" label="样本集名称" rules={[{ required: true }]}>
              <Input maxLength={120} />
            </Form.Item>
            <Form.Item name="template_key" label="SQL 模板">
              <Select
                allowClear
                placeholder="直接编辑 SQL"
                options={templateOptions}
                onChange={(value) => applyTemplate(value ?? null)}
              />
            </Form.Item>
            <Form.Item name="sample_limit" label="抽取条数" rules={[{ required: true }]}>
              <InputNumber min={1} max={BATCH_LAB_MAX_SAMPLE_LIMIT} className="full-width" />
            </Form.Item>
          </div>
          <Form.Item name="parameters_json" label="参数 JSON">
            <Input.TextArea rows={5} className="code-input" />
          </Form.Item>
          <Form.Item name="sql" label="SQL" rules={[{ required: true }]}>
            <Input.TextArea rows={8} className="code-input" />
          </Form.Item>
          <Space wrap>
            <Button
              type="primary"
              htmlType="submit"
              loading={previewMutation.isPending}
              disabled={!context.capabilities.sample_preview}
            >
              预览抽样
            </Button>
            <Button
              disabled={!preview || preview.statistics.valid_count === 0}
              loading={saveMutation.isPending}
              onClick={() => saveMutation.mutate(form.getFieldsValue())}
            >
              保存冻结样本集
            </Button>
          </Space>
        </Form>
      </Card>
      {preview ? <PreviewPanel preview={preview} /> : null}
    </section>
  );
}

function PreviewPanel({ preview }: { preview: BatchLabPreview }) {
  return (
    <Card className="section-gap" title="预览结果">
      <div className="stats-grid">
        <Statistic
          title="有效样本"
          value={preview.statistics.valid_count}
          suffix={`/ ${preview.statistics.requested_count}`}
        />
        <Statistic title="用户" value={preview.statistics.user_count} />
        <Statistic title="会话" value={preview.statistics.session_count} />
        <Statistic title="角色" value={preview.statistics.character_count} />
      </div>
      <Divider />
      <Table
        rowKey="source_history_id"
        size="small"
        dataSource={preview.items}
        scroll={{ x: 980 }}
        columns={[
          { title: '#', dataIndex: 'ordinal', width: 70 },
          {
            title: '锚点',
            render: (_, item) => (
              <Space direction="vertical" size={2}>
                <Typography.Text>{item.source_session_id}</Typography.Text>
                <Typography.Text type="secondary">
                  第 {item.turn_index} 轮 · revision {item.revision}
                </Typography.Text>
              </Space>
            ),
          },
          { title: '用户输入', dataIndex: 'user_input' },
          {
            title: '上下文',
            render: (_, item) => (
              <Collapse
                size="small"
                items={[
                  {
                    key: 'history',
                    label: `${item.history.length} 条窗口消息`,
                    children: (
                      <Space direction="vertical" className="full-width">
                        {item.history.map((messageItem, index) => (
                          <Typography.Paragraph
                            key={`${messageItem.role}-${index}`}
                            className="sample-message"
                          >
                            <Tag>{messageItem.role}</Tag>
                            {messageItem.content}
                          </Typography.Paragraph>
                        ))}
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
      {Object.keys(preview.statistics.excluded_by_reason).length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message="排除摘要"
          description={JSON.stringify(preview.statistics.excluded_by_reason)}
        />
      ) : null}
    </Card>
  );
}

function ProcessorsPage({
  processors,
  loading,
}: {
  processors: BatchLabProcessorVersion[];
  loading: boolean;
}) {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ProcessorFormValues>();
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<string | null>(null);

  const previewMutation = useMutation({
    mutationFn: (values: ProcessorFormValues) =>
      previewBatchLabProcessor({
        config: buildProcessorConfig(values.protocol, values.rules_json),
        input_text: values.input_text,
      }),
    onSuccess: (result) => {
      setPreviewHtml(result.sanitized_html);
      setPreviewStatus(displayStatusText(result.status));
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const saveMutation = useMutation({
    mutationFn: (values: ProcessorFormValues) =>
      createBatchLabProcessor({
        name: values.name,
        config: buildProcessorConfig(values.protocol, values.rules_json),
        idempotency_key: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      message.success('已保存不可变版本');
      await queryClient.invalidateQueries({ queryKey: ['batch-lab'] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const loadProcessor = (processor: BatchLabProcessorVersion) => {
    form.setFieldsValue({
      name: `${processor.name} · 修改版`,
      protocol: processor.protocol,
      rules_json: processorConfigToRulesJson(processor.config),
    });
    setPreviewHtml(null);
    setPreviewStatus(null);
  };

  return (
    <section className="section-gap">
      <div className="page-head">
        <div>
          <Typography.Title level={2}>富文本后处理</Typography.Title>
          <Typography.Text type="secondary">
            复制已有版本、预览原文、保存为不可变新版本。
          </Typography.Text>
        </div>
      </div>
      <div className="two-column">
        <Card title="规则编辑">
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              name: '状态栏与记忆 · 修改版',
              protocol: 'regex_json_v1',
              rules_json: '[]',
              input_text: '模型原始回复\n\n[status]地点：客厅｜情绪：平静[/status]',
            }}
            onValuesChange={() => {
              setPreviewHtml(null);
              setPreviewStatus(null);
            }}
            onFinish={(values) => previewMutation.mutate(values)}
          >
            <Form.Item name="name" label="新版本名称" rules={[{ required: true }]}>
              <Input maxLength={120} />
            </Form.Item>
            <Form.Item name="protocol" label="协议" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'regex_json_v1', label: 'regex_json_v1' },
                  { value: 'none_v1', label: 'none_v1' },
                ]}
              />
            </Form.Item>
            <Form.Item name="rules_json" label="规则 JSON 数组">
              <Input.TextArea rows={10} className="code-input" />
            </Form.Item>
            <Form.Item name="input_text" label="预览原文">
              <Input.TextArea rows={6} />
            </Form.Item>
            <Space wrap>
              <Button type="primary" htmlType="submit" loading={previewMutation.isPending}>
                运行预览
              </Button>
              <Button
                loading={saveMutation.isPending}
                onClick={() => saveMutation.mutate(form.getFieldsValue())}
              >
                保存新版本
              </Button>
            </Space>
          </Form>
        </Card>
        <Card title="预览">
          {previewHtml ? (
            <Space direction="vertical" className="full-width">
              <Tag color="green">{previewStatus}</Tag>
              <div className="rich-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </Space>
          ) : (
            <Typography.Text type="secondary">运行预览后显示用户展示结果。</Typography.Text>
          )}
        </Card>
      </div>
      <Card className="section-gap" title="已保存版本">
        <Table
          rowKey="id"
          loading={loading}
          dataSource={processors}
          scroll={{ x: 760 }}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '协议', dataIndex: 'protocol', width: 150 },
            { title: 'Digest', dataIndex: 'digest' },
            {
              title: '操作',
              width: 120,
              render: (_, record) => (
                <Button onClick={() => loadProcessor(record)}>复制编辑</Button>
              ),
            },
          ]}
        />
      </Card>
    </section>
  );
}

function ExperimentWizard({
  context,
  sampleSets,
  processors,
  loading,
  onCreated,
}: {
  context: BatchLabContext;
  sampleSets: BatchLabSampleSet[];
  processors: BatchLabProcessorVersion[];
  loading: boolean;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ExperimentFormValues>();
  const [confirmValues, setConfirmValues] = useState<ExperimentFormValues | null>(null);
  const processorOptions = useMemo(
    () => [
      { value: null, label: '不处理' },
      ...processors.map((processor) => ({
        value: processor.id,
        label: processorOptionLabel(processor),
      })),
    ],
    [processors]
  );

  const createMutation = useMutation({
    mutationFn: (values: ExperimentFormValues) =>
      createBatchLabExperiment({
        name: values.name,
        sample_set_id: values.sample_set_id,
        source_environment: context.source_environment,
        variants: [makeVariant(values, 0, 'a'), makeVariant(values, 1, 'b')],
        idempotency_key: newIdempotencyKey(),
      }),
    onSuccess: async (experiment) => {
      message.success('实验草稿已创建');
      await queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.experiments(context) });
      Modal.confirm({
        title: '立即启动实验？',
        content: `计划任务数：${experiment.total_attempts || '启动后生成'}`,
        okText: '启动',
        cancelText: '稍后',
        onOk: async () => {
          await startBatchLabExperiment({
            experiment_id: experiment.id,
            source_environment: context.source_environment,
            idempotency_key: newIdempotencyKey(),
          });
          await queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.experiments(context) });
          onCreated();
        },
        onCancel: onCreated,
      });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const copyBaseline = () => {
    const values = form.getFieldsValue();
    const baseline = values.variants?.[0];
    if (!baseline) return;
    form.setFieldValue(['variants', 1], { ...baseline, name: '候选 B' });
  };

  const initialValues: ExperimentFormValues = {
    name: '长对话 · 减少重复描写',
    sample_set_id: sampleSets[0]?.id ?? '',
    max_turns: 1,
    variants: [
      {
        name: '基准 A',
        model_id: 'current-online-model',
        openrouter_model_id: 'openrouter/current',
        tier: 'standard',
        is_free: false,
        sampling: '{"temperature":0.7,"top_p":0.9}',
        processor_version_id: processors[0]?.id ?? null,
      },
      {
        name: '候选 B',
        model_id: 'current-online-model',
        openrouter_model_id: 'openrouter/current',
        tier: 'standard',
        is_free: false,
        sampling: '{"temperature":0.7,"top_p":0.9}',
        processor_version_id: processors[1]?.id ?? processors[0]?.id ?? null,
      },
    ],
  };

  return (
    <section className="section-gap">
      <div className="page-head">
        <div>
          <Typography.Title level={2}>新建对比实验</Typography.Title>
          <Typography.Text type="secondary">
            每个版本冻结模型、采样参数、重跑轮数和后处理版本。
          </Typography.Text>
        </div>
      </div>
      {loading ? (
        <Skeleton active />
      ) : (
        <Form
          form={form}
          layout="vertical"
          initialValues={initialValues}
          onFinish={(values) => setConfirmValues(values)}
        >
          <Card title="样本与规模">
            <div className="form-grid three">
              <Form.Item name="name" label="实验名称" rules={[{ required: true }]}>
                <Input maxLength={120} />
              </Form.Item>
              <Form.Item name="sample_set_id" label="样本集" rules={[{ required: true }]}>
                <Select
                  options={sampleSets.map((sampleSet) => ({
                    value: sampleSet.id,
                    label: `${sampleSet.name} · ${sampleSet.sample_count} 条`,
                  }))}
                />
              </Form.Item>
              <Form.Item name="max_turns" label="重跑轮数 X" rules={[{ required: true }]}>
                <InputNumber min={1} max={BATCH_LAB_MAX_EXPERIMENT_TURNS} className="full-width" />
              </Form.Item>
            </div>
          </Card>
          <div className="two-column section-gap">
            {[0, 1].map((index) => (
              <Card
                key={index}
                title={index === 0 ? '组合 A · 基准' : '组合 B · 候选'}
                extra={index === 1 ? <Button onClick={copyBaseline}>从 A 复制</Button> : null}
              >
                <Form.Item
                  name={['variants', index, 'name']}
                  label="组合名称"
                  rules={[{ required: true }]}
                >
                  <Input maxLength={120} />
                </Form.Item>
                <Form.Item
                  name={['variants', index, 'model_id']}
                  label="模型 ID"
                  rules={[{ required: true }]}
                >
                  <Input maxLength={200} />
                </Form.Item>
                <Form.Item
                  name={['variants', index, 'openrouter_model_id']}
                  label="OpenRouter 模型"
                  rules={[{ required: true }]}
                >
                  <Input maxLength={200} />
                </Form.Item>
                <div className="form-grid two">
                  <Form.Item name={['variants', index, 'tier']} label="档位">
                    <Select
                      options={[
                        { value: 'light', label: 'light' },
                        { value: 'standard', label: 'standard' },
                        { value: 'premium', label: 'premium' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name={['variants', index, 'is_free']} label="免费模型">
                    <Select
                      options={[
                        { value: false, label: '否' },
                        { value: true, label: '是' },
                      ]}
                    />
                  </Form.Item>
                </div>
                <Form.Item name={['variants', index, 'sampling']} label="采样参数 JSON">
                  <Input.TextArea rows={5} className="code-input" />
                </Form.Item>
                <Form.Item name={['variants', index, 'processor_version_id']} label="后处理版本">
                  <Select options={processorOptions} />
                </Form.Item>
              </Card>
            ))}
          </div>
          <Space className="section-gap">
            <Button type="primary" htmlType="submit" disabled={sampleSets.length === 0}>
              确认运行规模与差异
            </Button>
          </Space>
        </Form>
      )}
      <ConfirmationModal
        context={context}
        sampleSets={sampleSets}
        values={confirmValues}
        onCancel={() => setConfirmValues(null)}
        onConfirm={(values) => createMutation.mutate(values)}
        confirmLoading={createMutation.isPending}
      />
    </section>
  );
}

function ConfirmationModal({
  context,
  sampleSets,
  values,
  onCancel,
  onConfirm,
  confirmLoading,
}: {
  context: BatchLabContext;
  sampleSets: BatchLabSampleSet[];
  values: ExperimentFormValues | null;
  onCancel: () => void;
  onConfirm: (values: ExperimentFormValues) => void;
  confirmLoading: boolean;
}) {
  const sampleSet = sampleSets.find((item) => item.id === values?.sample_set_id);
  const variants = values ? [makeVariant(values, 0, 'a'), makeVariant(values, 1, 'b')] : null;
  const plannedCalls = sampleSet && values ? sampleSet.sample_count * 2 * values.max_turns : 0;

  return (
    <Modal
      title="确认运行"
      open={values !== null}
      onCancel={onCancel}
      onOk={() => values && onConfirm(values)}
      okText="创建实验草稿"
      confirmLoading={confirmLoading}
      width={780}
    >
      {values && variants ? (
        <Space direction="vertical" size={16} className="full-width">
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="来源环境">{context.source_environment}</Descriptions.Item>
            <Descriptions.Item label="样本集">
              {sampleSet?.name ?? values.sample_set_id}
            </Descriptions.Item>
            <Descriptions.Item label="运行规模">{plannedCalls} 次计划调用</Descriptions.Item>
          </Descriptions>
          <Table
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={variantDiffRows(variants[0], variants[1])}
            columns={[
              { title: '字段', dataIndex: 'label' },
              { title: '基准 A', dataIndex: 'baseline' },
              { title: '候选 B', dataIndex: 'candidate' },
            ]}
            scroll={{ x: 640 }}
          />
        </Space>
      ) : null}
    </Modal>
  );
}
