import {
  Alert,
  Button,
  Card,
  Col,
  InputNumber,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  DEFAULT_FIRST_TOKEN_DEADLINE_MS,
  DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS,
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  DEFAULT_FIRST_TOKEN_TIMEOUT_RATE_TARGET,
  FIRST_TOKEN_FALLBACK_MODEL_ID,
  ModelCatalogSchema,
  type ModelCatalog,
  type ModelCatalogModel,
  type ProviderModelDirectory,
} from '@miniapp/shared';

export function FallbackConfigEditor(props: {
  value: ModelCatalog;
  onChange: (value: ModelCatalog) => void;
  disabled?: boolean;
  directory?: ProviderModelDirectory;
  loading?: boolean;
  error?: string | null;
  onRefresh: () => void;
}) {
  const fallbackId = props.value.fallback_model_id ?? FIRST_TOKEN_FALLBACK_MODEL_ID;
  const deadline = props.value.first_token_deadline_ms ?? DEFAULT_FIRST_TOKEN_DEADLINE_MS;
  const models = props.value.tiers.flatMap((tier) => tier.models);
  const options = (props.directory?.models ?? []).map((model) => ({
    value: model.id,
    label: `${model.name} (${model.id})`,
    disabled: model.status !== 'available',
  }));
  // Keep the saved choice visible even while a directory refresh is unavailable.
  if (!options.some((option) => option.value === fallbackId)) {
    options.unshift({ value: fallbackId, label: `${fallbackId}（待目录校验）`, disabled: true });
  }
  const validation = ModelCatalogSchema.safeParse(props.value);
  const timingErrors = validation.success
    ? []
    : validation.error.issues
        .filter((issue) =>
          issue.path.some((part) =>
            [
              'fallback_model_id',
              'fallback_timeout_ms',
              'first_token_timeout_ms',
              'first_token_deadline_ms',
              'first_token_timeout_rate_target',
            ].includes(String(part))
          )
        )
        .map((issue) => issue.message);

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Card
        size="small"
        title="兜底模型"
        extra={
          <Button loading={props.loading} onClick={props.onRefresh}>
            刷新 OpenRouter 目录
          </Button>
        }
      >
        <Space direction="vertical" className="field-full">
          <Typography.Text>模型型号</Typography.Text>
          <Select
            aria-label="兜底模型型号"
            className="field-full"
            showSearch
            optionFilterProp="label"
            value={fallbackId}
            options={options}
            loading={props.loading}
            disabled={props.disabled}
            onChange={(fallback_model_id) => props.onChange({ ...props.value, fallback_model_id })}
          />
          <Typography.Text type="secondary">
            使用现有 OpenRouter key。首发或兜底获胜，都按用户所选型号的价格与权益，只结算一次。
          </Typography.Text>
          {props.error ? <Alert type="error" showIcon message={props.error} /> : null}
          {!props.directory && !props.loading ? (
            <Alert type="info" showIcon message="请刷新目录后选择兜底型号。" />
          ) : null}
        </Space>
      </Card>

      <Card size="small" title="兜底预留时间">
        <Typography.Paragraph>前置处理过慢时，为提前启动兜底预留（秒）</Typography.Paragraph>
        <InputNumber
          aria-label="兜底预留时间（秒）"
          min={0.001}
          max={(deadline - 1) / 1000}
          step={0.5}
          disabled={props.disabled}
          value={(props.value.fallback_timeout_ms ?? DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS) / 1000}
          onChange={(value) =>
            value !== null &&
            props.onChange({ ...props.value, fallback_timeout_ms: Math.round(value * 1000) })
          }
        />
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          默认将总截止前2秒作为最迟启动点；如果前置处理已超过这个时刻，就立即启动。兜底仍可等待至共同截止，剩余时间以实际预算为准。
        </Typography.Paragraph>
      </Card>
      <Card size="small" title="全局等待与监控目标">
        <Row gutter={[20, 16]}>
          <Col xs={24} md={12}>
            <Typography.Paragraph>首 token 总等待上限（秒）</Typography.Paragraph>
            <InputNumber
              aria-label="首 token 总等待上限（秒）"
              className="field-full"
              min={0.001}
              max={110}
              step={0.5}
              disabled={props.disabled}
              value={deadline / 1000}
              onChange={(value) =>
                value !== null &&
                props.onChange({
                  ...props.value,
                  first_token_deadline_ms: Math.round(value * 1000),
                })
              }
            />
          </Col>
          <Col xs={24} md={12}>
            <Typography.Paragraph>可接受超时率（%）</Typography.Paragraph>
            <InputNumber
              aria-label="可接受超时率（%）"
              className="field-full"
              min={0}
              max={100}
              step={0.1}
              disabled={props.disabled}
              value={
                (props.value.first_token_timeout_rate_target ??
                  DEFAULT_FIRST_TOKEN_TIMEOUT_RATE_TARGET) * 100
              }
              onChange={(value) =>
                value !== null &&
                props.onChange({ ...props.value, first_token_timeout_rate_target: value / 100 })
              }
            />
          </Col>
        </Row>
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
          总等待从用户发送到首个正文或已开启思考的 token
          进入消息界面，包含前置处理、模型请求、网络与客户端处理。默认首发等待4秒启动兜底，首发继续；所有请求共用10秒总截止。先出有效首字的一方负责本轮回复，另一方立即停止。到总截止仍未交付首字则轻提示重试。超时率是人工监控目标，不会自动调整参数。
        </Typography.Paragraph>
      </Card>

      <Card size="small" title="各型号启动兜底阈值">
        <Typography.Paragraph type="secondary">
          新增型号默认从首发实际请求派发开始等待4秒，仍未出有效首 token
          就启动上方兜底模型，首发继续竞争。首字前明确失败立即启用兜底；同型号静默等待不重复请求，继续至总截止，明确失败最多顺序重试一次。思考模式同样执行；前置处理过慢时按预留时间提前启动。每项必须小于总等待上限。
        </Typography.Paragraph>
        <Table<ModelCatalogModel>
          rowKey="id"
          size="small"
          pagination={false}
          scroll={{ x: 560 }}
          dataSource={models}
          columns={[
            {
              title: '首发型号',
              key: 'model',
              render: (_, model) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{model.display_name}</Typography.Text>
                  <Typography.Text type="secondary">{model.id}</Typography.Text>
                </Space>
              ),
            },
            {
              title: '状态',
              key: 'status',
              width: 100,
              render: (_, model) => (
                <Tag color={model.enabled ? 'green' : 'default'}>
                  {model.enabled ? '已上架' : '未上架'}
                </Tag>
              ),
            },
            {
              title: '启动兜底阈值（秒）',
              key: 'wait',
              width: 180,
              render: (_, model) => (
                <InputNumber
                  aria-label={`${model.display_name}启动兜底阈值（秒）`}
                  min={0.001}
                  max={(deadline - 1) / 1000}
                  step={0.5}
                  disabled={props.disabled}
                  value={(model.first_token_timeout_ms ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS) / 1000}
                  onChange={(value) =>
                    value !== null &&
                    props.onChange({
                      ...props.value,
                      tiers: props.value.tiers.map((tier) => ({
                        ...tier,
                        models: tier.models.map((item) =>
                          item.id === model.id
                            ? { ...item, first_token_timeout_ms: Math.round(value * 1000) }
                            : item
                        ),
                      })),
                    })
                  }
                />
              ),
            },
          ]}
        />
      </Card>
      {timingErrors.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message="请调整以下配置后保存"
          description={[...new Set(timingErrors)].join('；')}
        />
      ) : null}
      <Typography.Paragraph type="secondary">
        本页与模型目录共用一份草稿及发布历史。自动保存仅保存草稿，点击“发布草稿”后生效；只影响新受理的请求。
      </Typography.Paragraph>
    </Space>
  );
}
