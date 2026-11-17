import type {
  ImagePlazaAspectRatio,
  ImagePlazaModelCatalog,
  ImagePlazaShareTipConfig,
  ProviderImagePlazaModel,
} from '@miniapp/shared';
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
import {
  IMAGE_PLAZA_PRICING_INPUT_MAX,
  calculateImagePlazaPrice,
  getImagePlazaPricingFactors,
  imagePlazaPriceKey,
  type ImagePlazaPricingFactors,
} from '../lib/imagePlazaPricing';
import { ImagePlazaPricingEditor } from './ImagePlazaPricingEditor';

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
  const factors = getImagePlazaPricingFactors(props.value);
  const standardPrices = props.value.standard_prices ?? {};
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
      <ImagePlazaPricingEditor {...props} />
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
            <Col xs={24} md={8}>
              <Typography.Text>编辑 Provider ID</Typography.Text>
              <Input
                value={model.edit_provider_model_id ?? ''}
                disabled={props.disabled || !model.supports_edit}
                placeholder="不支持编辑时留空"
                onChange={(event) =>
                  patchModel(index, { edit_provider_model_id: event.target.value.trim() || null })
                }
              />
            </Col>
            <Col xs={24} md={8}>
              <Typography.Text>尺寸参数模式</Typography.Text>
              <Select
                className="field-full"
                value={model.sizing_mode}
                disabled={props.disabled}
                options={[
                  { value: 'resolution', label: '画幅 + 分辨率档' },
                  { value: 'aspect_ratio', label: '仅画幅' },
                  { value: 'pixels', label: '像素宽高' },
                ]}
                onChange={(sizing_mode) => patchModel(index, { sizing_mode })}
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
                  onChange={(supports_i2i) =>
                    patchModel(index, {
                      supports_i2i,
                      supports_edit: supports_i2i ? model.supports_edit : false,
                      edit_provider_model_id: supports_i2i ? model.edit_provider_model_id : null,
                    })
                  }
                />
                <Typography.Text>参考图</Typography.Text>
              </Space>
            </Col>
            <Col xs={12} md={6}>
              <Space>
                <Switch
                  checked={model.supports_edit}
                  disabled={props.disabled}
                  onChange={(supports_edit) =>
                    patchModel(index, {
                      supports_edit,
                      supports_i2i: supports_edit ? true : model.supports_i2i,
                      edit_provider_model_id: supports_edit ? model.edit_provider_model_id : null,
                    })
                  }
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
                    label={`${tier.label} (${tier.id})`}
                    credits={tier.credits}
                    usd={standardPrices[imagePlazaPriceKey(model.id, tier.id)] ?? null}
                    factors={factors}
                    onUsdChange={(usd) =>
                      props.onChange({
                        ...props.value,
                        standard_prices: {
                          ...standardPrices,
                          [imagePlazaPriceKey(model.id, tier.id)]: usd,
                        },
                      })
                    }
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
  usd: number | null;
  factors: ImagePlazaPricingFactors;
  onUsdChange: (value: number | null) => void;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const price = calculateImagePlazaPrice(props.usd, props.factors);
  return (
    <Card size="small">
      <Space wrap>
        <Typography.Text strong>{props.label}</Typography.Text>
        <InputNumber
          aria-label={`${props.label} USD 标准价`}
          addonBefore="USD 标准价"
          placeholder="本次必填"
          min={0.0001}
          max={IMAGE_PLAZA_PRICING_INPUT_MAX}
          precision={4}
          value={props.usd}
          disabled={props.disabled}
          onChange={props.onUsdChange}
        />
        <Typography.Text type="secondary">
          {price ? `预览：${price.raw} → ${price.credits} 星尘` : '请填写有效标准价及统一参数'}
        </Typography.Text>
        <Button
          disabled={props.disabled || !price}
          onClick={() => {
            if (!props.disabled && price) props.onChange(price.credits);
          }}
        >
          重算
        </Button>
        <InputNumber
          aria-label={`${props.label} 上架星尘价`}
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

export { ImagePlazaTagsEditor } from './ImagePlazaTagsEditor';
export { VideoPlazaModelCatalogEditor } from './VideoPlazaConfigEditor';
