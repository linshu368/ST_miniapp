import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import type {
  ImagePlazaAspectRatio,
  ImagePlazaModelCatalog,
  ImagePlazaShareTipConfig,
  ImagePlazaTagConfig,
  ProviderImagePlazaModel,
} from '@miniapp/shared';

const RATIOS: ImagePlazaAspectRatio[] = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '9:16',
  '16:9',
  '21:9',
];

export function ImagePlazaModelCatalogEditor(props: {
  value: ImagePlazaModelCatalog;
  disabled?: boolean;
  onChange: (value: ImagePlazaModelCatalog) => void;
}) {
  const patchModel = (index: number, patch: Partial<ProviderImagePlazaModel>) => {
    const models = structuredClone(props.value.models);
    models[index] = { ...models[index], ...patch };
    props.onChange({ ...props.value, models });
  };
  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Alert
        showIcon
        type="info"
        message="用户端只读取已发布目录"
        description="业务 ID 发布后保持稳定；Anime 的 provider ID 为 wai-Illustrious。报价和扣费均读取各分辨率的上架星尘价，有参考图不加价。"
      />
      <div>
        <Typography.Text strong>默认模型</Typography.Text>
        <Select
          className="field-full"
          value={props.value.default_model_id}
          disabled={props.disabled}
          options={props.value.models
            .filter((model) => model.enabled)
            .map((model) => ({ value: model.id, label: model.name }))}
          onChange={(default_model_id) => props.onChange({ ...props.value, default_model_id })}
        />
      </div>
      {props.value.models.map((model, index) => (
        <Card
          key={model.id}
          size="small"
          title={`${index + 1}. ${model.name}`}
          extra={
            <Switch
              checked={model.enabled}
              disabled={props.disabled}
              checkedChildren="上架"
              unCheckedChildren="下架"
              onChange={(enabled) => patchModel(index, { enabled })}
            />
          }
        >
          <Row gutter={[12, 12]}>
            <Col xs={24} md={8}>
              <Typography.Text>业务 ID</Typography.Text>
              <Input value={model.id} disabled />
            </Col>
            <Col xs={24} md={8}>
              <Typography.Text>展示名称</Typography.Text>
              <Input
                value={model.name}
                disabled={props.disabled}
                onChange={(event) => patchModel(index, { name: event.target.value })}
              />
            </Col>
            <Col xs={24} md={8}>
              <Typography.Text>Provider ID</Typography.Text>
              <Input
                value={model.provider_model_id}
                disabled={props.disabled}
                onChange={(event) => patchModel(index, { provider_model_id: event.target.value })}
              />
            </Col>
            <Col span={24}>
              <Typography.Text>适用场景</Typography.Text>
              <Input
                value={model.description}
                maxLength={240}
                disabled={props.disabled}
                onChange={(event) => patchModel(index, { description: event.target.value })}
              />
            </Col>
            <Col xs={12} md={6}>
              <Space>
                <Switch
                  checked={model.supports_i2i}
                  disabled={props.disabled}
                  onChange={(supports_i2i) => patchModel(index, { supports_i2i })}
                />
                <Typography.Text>参考图</Typography.Text>
              </Space>
            </Col>
            <Col xs={12} md={6}>
              <Space>
                <Switch
                  checked={model.supports_edit}
                  disabled={props.disabled}
                  onChange={(supports_edit) => patchModel(index, { supports_edit })}
                />
                <Typography.Text>编辑</Typography.Text>
              </Space>
            </Col>
            <Col xs={24} md={12}>
              <Typography.Text>画幅</Typography.Text>
              <Select
                mode="multiple"
                className="field-full"
                value={model.aspect_ratios}
                disabled={props.disabled}
                options={RATIOS.map((value) => ({ value, label: value }))}
                onChange={(aspect_ratios) => patchModel(index, { aspect_ratios })}
              />
            </Col>
            <Col span={24}>
              <Typography.Text strong>上架星尘价</Typography.Text>
              <Space direction="vertical" className="editor-stack">
                {model.resolutions.map((tier, tierIndex) => (
                  <PricingRow
                    key={tier.id}
                    label={tier.label}
                    credits={tier.credits}
                    disabled={props.disabled}
                    onChange={(credits) => {
                      const resolutions = structuredClone(model.resolutions);
                      resolutions[tierIndex].credits = credits;
                      patchModel(index, { resolutions });
                    }}
                  />
                ))}
              </Space>
            </Col>
          </Row>
        </Card>
      ))}
    </Space>
  );
}

function PricingRow(props: {
  label: string;
  credits: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [usd, setUsd] = useState(1);
  const [exchange, setExchange] = useState(7.2);
  const [markup, setMarkup] = useState(1.5);
  const [ratio, setRatio] = useState(10);
  const calculate = () =>
    props.onChange(Math.max(10, Math.ceil((usd * exchange * markup * ratio) / 10) * 10));
  return (
    <Card size="small">
      <Space wrap>
        <Typography.Text strong>{props.label}</Typography.Text>
        <InputNumber
          addonBefore="USD"
          min={0}
          precision={4}
          value={usd}
          disabled={props.disabled}
          onChange={(value) => setUsd(value ?? 0)}
        />
        <InputNumber
          addonBefore="汇率"
          min={0.01}
          precision={4}
          value={exchange}
          disabled={props.disabled}
          onChange={(value) => setExchange(value ?? 0.01)}
        />
        <InputNumber
          addonBefore="倍率"
          min={0.01}
          precision={4}
          value={markup}
          disabled={props.disabled}
          onChange={(value) => setMarkup(value ?? 0.01)}
        />
        <InputNumber
          addonBefore="比例"
          min={0.01}
          precision={4}
          value={ratio}
          disabled={props.disabled}
          onChange={(value) => setRatio(value ?? 0.01)}
        />
        <Button disabled={props.disabled} onClick={calculate}>
          重算
        </Button>
        <InputNumber
          addonBefore="上架价"
          min={1}
          precision={0}
          value={props.credits}
          disabled={props.disabled}
          onChange={(value) => props.onChange(value ?? 1)}
        />
      </Space>
    </Card>
  );
}

export function ImagePlazaShareTipEditor(props: {
  value: ImagePlazaShareTipConfig;
  disabled?: boolean;
  onChange: (value: ImagePlazaShareTipConfig) => void;
}) {
  const patch = (value: Partial<ImagePlazaShareTipConfig>) =>
    props.onChange({ ...props.value, ...value });
  return (
    <Row gutter={[20, 20]}>
      <Col xs={24} lg={12}>
        <Space direction="vertical" size="middle" className="editor-stack">
          <Space>
            <Switch
              checked={props.value.enabled}
              disabled={props.disabled}
              onChange={(enabled) => patch({ enabled })}
            />
            <Typography.Text strong>首次分享弹窗</Typography.Text>
          </Space>
          <Input
            addonBefore="标题"
            value={props.value.title}
            maxLength={80}
            disabled={props.disabled}
            onChange={(event) => patch({ title: event.target.value })}
          />
          <Input.TextArea
            value={props.value.description}
            rows={4}
            maxLength={300}
            showCount
            disabled={props.disabled}
            onChange={(event) => patch({ description: event.target.value })}
          />
          <Input
            addonBefore="参考图提示"
            value={props.value.reference_note}
            maxLength={160}
            disabled={props.disabled}
            onChange={(event) => patch({ reference_note: event.target.value })}
          />
          <Input
            addonBefore="按钮"
            value={props.value.button_label}
            maxLength={40}
            disabled={props.disabled}
            onChange={(event) => patch({ button_label: event.target.value })}
          />
          <Alert
            type="info"
            showIcon
            message="仅支持 {rate} 与 {model} 占位符；不支持金额占位符。"
          />
        </Space>
      </Col>
      <Col xs={24} lg={12}>
        <Card title="手机预览">
          <div
            style={{
              maxWidth: 320,
              margin: '0 auto',
              borderRadius: 24,
              overflow: 'hidden',
              background: '#171717',
              color: '#fff',
            }}
          >
            <div
              style={{
                aspectRatio: '4/3',
                display: 'grid',
                placeItems: 'center',
                background: 'linear-gradient(135deg,#6d4aff,#e7a94d)',
              }}
            >
              <Typography.Text style={{ color: '#fff' }}>用户真实作品图</Typography.Text>
            </div>
            <div style={{ padding: 20, textAlign: 'center' }}>
              <h3>{previewText(props.value.title)}</h3>
              <p>{previewText(props.value.description)}</p>
              <Button type="primary" block>
                {props.value.button_label}
              </Button>
            </div>
          </div>
        </Card>
      </Col>
    </Row>
  );
}

function previewText(value: string): string {
  return value.replace(/\{rate\}/g, '30%').replace(/\{model\}/g, 'Seedream V5 Pro');
}

export function ImagePlazaTagsEditor(props: {
  value: ImagePlazaTagConfig;
  disabled?: boolean;
  onChange: (value: ImagePlazaTagConfig) => void;
}) {
  const update = (index: number, patch: Partial<ImagePlazaTagConfig[number]>) => {
    const next = structuredClone(props.value);
    next[index] = { ...next[index], ...patch };
    props.onChange(next);
  };
  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Alert
        showIcon
        type="info"
        message="“全部”是系统固定标签"
        description="删除运营标签只影响后续筛选入口，不会删除作品或改写历史作品标签。"
      />
      <Card size="small">
        <Row gutter={12}>
          <Col span={8}>
            <Input value="all" disabled />
          </Col>
          <Col span={10}>
            <Input value="全部" disabled />
          </Col>
          <Col span={6}>
            <Switch checked disabled />
          </Col>
        </Row>
      </Card>
      {props.value.map((tag, index) => (
        <Card key={`${tag.id}-${index}`} size="small">
          <Row gutter={[12, 12]} align="middle">
            <Col xs={24} md={7}>
              <Input
                addonBefore="ID"
                value={tag.id}
                disabled={props.disabled}
                onChange={(event) => update(index, { id: event.target.value })}
              />
            </Col>
            <Col xs={24} md={7}>
              <Input
                addonBefore="名称"
                value={tag.label}
                disabled={props.disabled}
                onChange={(event) => update(index, { label: event.target.value })}
              />
            </Col>
            <Col xs={8} md={3}>
              <Switch
                checked={tag.enabled}
                disabled={props.disabled}
                onChange={(enabled) => update(index, { enabled })}
              />
            </Col>
            <Col xs={8} md={3}>
              <InputNumber
                min={0}
                precision={0}
                value={tag.sort_order}
                disabled={props.disabled}
                onChange={(sort_order) => update(index, { sort_order: sort_order ?? 0 })}
              />
            </Col>
            <Col xs={8} md={4}>
              <Button
                danger
                block
                disabled={props.disabled}
                onClick={() =>
                  props.onChange(props.value.filter((_, itemIndex) => itemIndex !== index))
                }
              >
                删除
              </Button>
            </Col>
          </Row>
        </Card>
      ))}
      <Button
        block
        disabled={props.disabled}
        onClick={() =>
          props.onChange([
            ...props.value,
            {
              id: `tag-${Date.now()}`,
              label: '新标签',
              enabled: true,
              sort_order: props.value.length,
            },
          ])
        }
      >
        添加标签
      </Button>
    </Space>
  );
}
