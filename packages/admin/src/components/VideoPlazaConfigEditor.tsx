import {
  getDefaultVideoPlazaModelOptions,
  normalizeVideoPlazaCatalogOptions,
} from '@miniapp/admin-client';
import type { ProviderVideoPlazaModel, VideoPlazaModelCatalog } from '@miniapp/shared';
import { Alert, Card, Col, Input, InputNumber, Row, Select, Space, Switch, Typography } from 'antd';

export function VideoPlazaModelCatalogEditor(props: {
  value: VideoPlazaModelCatalog;
  disabled?: boolean;
  onChange: (value: VideoPlazaModelCatalog) => void;
}) {
  const patchModel = (index: number, patch: Partial<ProviderVideoPlazaModel>) => {
    const models = structuredClone(props.value.models);
    models[index] = { ...models[index], ...patch };
    props.onChange({ ...props.value, models });
  };
  const patchModelOptions = (index: number, patch: Partial<ProviderVideoPlazaModel>) => {
    const models = structuredClone(props.value.models);
    models[index] = { ...models[index], ...patch };
    props.onChange(normalizeVideoPlazaCatalogOptions({ ...props.value, models }));
  };
  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Alert
        type="warning"
        showIcon
        message="占位价格禁止直接发布"
        description="时长固定为 5/10 秒，画幅固定为 16:9、9:16、1:1，清晰度按各模型能力限制为 720P/1080P；发布前仍须根据 Venice /video/quote 核价并补全真实星尘价格。"
      />
      <div>
        <Typography.Text strong>默认模型</Typography.Text>
        <Select
          className="field-full"
          value={props.value.default_model_id}
          disabled={props.disabled}
          options={props.value.models
            .filter((item) => item.enabled)
            .map((item) => ({ value: item.id, label: item.name }))}
          onChange={(default_model_id) => props.onChange({ ...props.value, default_model_id })}
        />
      </div>
      {props.value.models.map((model, index) => (
        <VideoModelCard
          key={model.id}
          model={model}
          index={index}
          disabled={props.disabled}
          patchModel={patchModel}
          patchModelOptions={patchModelOptions}
        />
      ))}
    </Space>
  );
}

type ModelFieldsProps = {
  model: ProviderVideoPlazaModel;
  index: number;
  disabled?: boolean;
  patchModel: (index: number, patch: Partial<ProviderVideoPlazaModel>) => void;
  patchModelOptions: (index: number, patch: Partial<ProviderVideoPlazaModel>) => void;
};

function VideoModelCard({
  model,
  index,
  disabled,
  patchModel,
  patchModelOptions,
}: ModelFieldsProps) {
  return (
    <Card
      size="small"
      title={`${index + 1}. ${model.name}`}
      extra={
        <Switch
          checked={model.enabled}
          disabled={disabled}
          checkedChildren="上架"
          unCheckedChildren="下架"
          onChange={(enabled) => patchModel(index, { enabled })}
        />
      }
    >
      <Row gutter={[12, 12]}>
        <VideoIdentityFields
          model={model}
          index={index}
          disabled={disabled}
          patchModel={patchModel}
        />
        <Col xs={24} md={8}>
          <Typography.Text>附图模式</Typography.Text>
          <Select
            className="field-full"
            value={model.image_input}
            disabled={disabled}
            options={[
              'none',
              'optional_first_frame',
              'optional_reference',
              'required_reference',
            ].map((value) => ({ value, label: value }))}
            onChange={(image_input) => patchModel(index, { image_input })}
          />
        </Col>
        {(['t2v', 'i2v', 'r2v'] as const).map((mode) => (
          <Col key={mode} xs={24} md={8}>
            <Typography.Text>{mode} Provider ID</Typography.Text>
            <Input
              value={model.provider_ids[mode] ?? ''}
              disabled={disabled}
              onChange={(event) =>
                patchModel(index, {
                  provider_ids: {
                    ...model.provider_ids,
                    [mode]: event.target.value.trim() || undefined,
                  },
                })
              }
            />
          </Col>
        ))}
        <VideoDescriptionField
          model={model}
          index={index}
          disabled={disabled}
          patchModel={patchModel}
        />
        <VideoOptionFields
          model={model}
          index={index}
          disabled={disabled}
          patchModelOptions={patchModelOptions}
        />
        <Col span={24}>
          <Typography.Text strong>价格矩阵（星尘）</Typography.Text>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {Object.entries(model.price_matrix).map(([key, credits]) => (
              <InputNumber
                key={key}
                addonBefore={key}
                min={1}
                max={1_000_000}
                precision={1}
                value={credits}
                disabled={disabled}
                onChange={(value) =>
                  patchModel(index, {
                    price_matrix: { ...model.price_matrix, [key]: value ?? 1 },
                  })
                }
              />
            ))}
          </div>
        </Col>
      </Row>
    </Card>
  );
}

function VideoDescriptionField({
  model,
  index,
  disabled,
  patchModel,
}: Omit<ModelFieldsProps, 'patchModelOptions'>) {
  return (
    <Col span={24}>
      <Typography.Text>说明</Typography.Text>
      <Input
        value={model.description}
        disabled={disabled}
        maxLength={240}
        onChange={(event) => patchModel(index, { description: event.target.value })}
      />
    </Col>
  );
}

function VideoIdentityFields({
  model,
  index,
  disabled,
  patchModel,
}: Omit<ModelFieldsProps, 'patchModelOptions'>) {
  return (
    <>
      <Col xs={24} md={8}>
        <Typography.Text>业务 ID</Typography.Text>
        <Input value={model.id} disabled />
      </Col>
      <Col xs={24} md={8}>
        <Typography.Text>名称</Typography.Text>
        <Input
          value={model.name}
          disabled={disabled}
          onChange={(event) => patchModel(index, { name: event.target.value })}
        />
      </Col>
    </>
  );
}

function VideoOptionFields({
  model,
  index,
  disabled,
  patchModelOptions,
}: Omit<ModelFieldsProps, 'patchModel'>) {
  return (
    <>
      <Col xs={24} md={8}>
        <Typography.Text>时长（秒）</Typography.Text>
        <Select
          mode="multiple"
          className="field-full"
          value={model.durations.map(String)}
          disabled={disabled}
          options={(getDefaultVideoPlazaModelOptions(model.id)?.durations ?? model.durations).map(
            (value) => ({
              value: String(value),
              label: `${value} 秒`,
            })
          )}
          onChange={(values) => patchModelOptions(index, { durations: values.map(Number) })}
        />
      </Col>
      <Col xs={24} md={8}>
        <Typography.Text>清晰度</Typography.Text>
        <Select
          mode="multiple"
          className="field-full"
          value={model.resolutions}
          disabled={disabled}
          options={(
            getDefaultVideoPlazaModelOptions(model.id)?.resolutions ?? model.resolutions
          ).map((value) => ({ value, label: value.toUpperCase() }))}
          onChange={(resolutions) => patchModelOptions(index, { resolutions })}
        />
      </Col>
      <Col xs={24} md={8}>
        <Typography.Text>画幅</Typography.Text>
        <Select
          mode="multiple"
          className="field-full"
          value={model.aspect_ratios}
          disabled={disabled}
          options={(
            getDefaultVideoPlazaModelOptions(model.id)?.aspect_ratios ?? model.aspect_ratios
          ).map((value) => ({ value, label: value }))}
          onChange={(aspect_ratios) => patchModelOptions(index, { aspect_ratios })}
        />
      </Col>
    </>
  );
}
