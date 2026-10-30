import { useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
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
  ProviderVideoPlazaModel,
  VideoPlazaModelCatalog,
} from '@miniapp/shared';
import { ImagePlazaTagConfigSchema } from '@miniapp/shared';
import {
  calculateImagePlazaPrice,
  imagePlazaPriceKey,
  IMAGE_PLAZA_PRICING_INPUT_MAX,
  recalculateImagePlazaCatalog,
  type ImagePlazaPricingFactors,
} from '../lib/imagePlazaPricing';
import {
  getDefaultVideoPlazaModelOptions,
  normalizeVideoPlazaCatalogOptions,
} from '../lib/configSchemas';

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
  const { message } = AntApp.useApp();
  const [factors, setFactors] = useState<ImagePlazaPricingFactors>({
    exchange: 7.3,
    markup: 2,
    ratio: 100,
  });
  const standardPrices = props.value.standard_prices ?? {};
  const recalculated = recalculateImagePlazaCatalog(props.value, standardPrices, factors);
  const exampleModel = props.value.models.find((model) =>
    model.resolutions.some((tier) =>
      calculateImagePlazaPrice(standardPrices[imagePlazaPriceKey(model.id, tier.id)], factors)
    )
  );
  const exampleTier = exampleModel?.resolutions.find((tier) =>
    calculateImagePlazaPrice(standardPrices[imagePlazaPriceKey(exampleModel.id, tier.id)], factors)
  );
  const exampleUsd =
    exampleModel && exampleTier
      ? standardPrices[imagePlazaPriceKey(exampleModel.id, exampleTier.id)]
      : null;
  const examplePrice = calculateImagePlazaPrice(exampleUsd, factors);
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
      <Card size="small" title="统一定价参数（仅本次页面有效）">
        <Space direction="vertical" className="editor-stack">
          <Typography.Text type="secondary">
            请填写每个模型各档位的 USD
            标准价（含下架模型）。标准价随“保存草稿”保存，刷新后可继续使用；以下统一参数仅本次页面有效。
          </Typography.Text>
          <Space wrap>
            <Typography.Text strong>原平台价 USD ×</Typography.Text>
            <InputNumber
              aria-label="统一汇率"
              addonBefore="汇率"
              min={0.0001}
              max={IMAGE_PLAZA_PRICING_INPUT_MAX}
              precision={4}
              value={factors.exchange}
              disabled={props.disabled}
              onChange={(exchange) => setFactors((current) => ({ ...current, exchange }))}
            />
            <Typography.Text>×</Typography.Text>
            <InputNumber
              aria-label="统一加价倍率"
              addonBefore="加价倍率"
              min={0.0001}
              max={IMAGE_PLAZA_PRICING_INPUT_MAX}
              precision={4}
              value={factors.markup}
              disabled={props.disabled}
              onChange={(markup) => setFactors((current) => ({ ...current, markup }))}
            />
            <Typography.Text>×</Typography.Text>
            <InputNumber
              aria-label="每元星尘数"
              addonAfter="星尘 = 1 元"
              min={0.0001}
              max={IMAGE_PLAZA_PRICING_INPUT_MAX}
              precision={4}
              value={factors.ratio}
              disabled={props.disabled}
              onChange={(ratio) => setFactors((current) => ({ ...current, ratio }))}
            />
            <Button
              type="primary"
              disabled={props.disabled || !recalculated.catalog}
              onClick={() => {
                if (props.disabled || !recalculated.catalog) return;
                props.onChange(recalculated.catalog);
                message.success('已重算所有模型档位的上架价；请保存草稿并发布后生效。');
              }}
            >
              一键重算
            </Button>
          </Space>
          <Typography.Text type="secondary">
            尾数不足 10
            星尘自动向上补整十。修改参数只更新预览，点击重算才会覆盖上架价草稿（包括手工价格）。
          </Typography.Text>
          {recalculated.issues.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`暂不能批量重算：${recalculated.issues.length} 个档位缺少有效标准价、参数无效或结果超出安全范围`}
              description={`请检查：${recalculated.issues.join('；')}。输入必须大于 0、不超过 1,000,000，最多四位小数。`}
            />
          )}
        </Space>
      </Card>
      <Card size="small" title="定价公式预览">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="公式">
            星尘价 = 向上补整十（USD × 汇率 × 加价倍率 × 每元星尘数）
          </Descriptions.Item>
          <Descriptions.Item label="示例">
            {examplePrice && exampleModel && exampleTier
              ? `${exampleModel.name} / ${exampleTier.label} (${exampleTier.id})：${exampleUsd} × ${factors.exchange} × ${factors.markup} × ${factors.ratio} = ${examplePrice.raw} → ${examplePrice.credits} 星尘`
              : '填写至少一个档位的有效 USD 标准价和统一参数后显示实时示例。'}
          </Descriptions.Item>
          <Descriptions.Item label="换算">
            {factors.ratio ?? '—'} 星尘 = 1 元人民币；此比例仅用于本页计算，不修改钱包或充值配置。
          </Descriptions.Item>
          <Descriptions.Item label="生效">
            重算仅修改当前草稿，保存并发布后供新生成使用；历史订单不回溯。
          </Descriptions.Item>
        </Descriptions>
      </Card>
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
              <Typography.Text>名称</Typography.Text>
              <Input
                value={model.name}
                disabled={props.disabled}
                onChange={(event) => patchModel(index, { name: event.target.value })}
              />
            </Col>
            <Col xs={24} md={8}>
              <Typography.Text>附图模式</Typography.Text>
              <Select
                className="field-full"
                value={model.image_input}
                disabled={props.disabled}
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
                  disabled={props.disabled}
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
            <Col span={24}>
              <Typography.Text>说明</Typography.Text>
              <Input
                value={model.description}
                disabled={props.disabled}
                maxLength={240}
                onChange={(event) => patchModel(index, { description: event.target.value })}
              />
            </Col>
            <Col xs={24} md={8}>
              <Typography.Text>时长（秒）</Typography.Text>
              <Select
                mode="multiple"
                className="field-full"
                value={model.durations.map(String)}
                disabled={props.disabled}
                options={(
                  getDefaultVideoPlazaModelOptions(model.id)?.durations ?? model.durations
                ).map((value) => ({
                  value: String(value),
                  label: `${value} 秒`,
                }))}
                onChange={(values) => patchModelOptions(index, { durations: values.map(Number) })}
              />
            </Col>
            <Col xs={24} md={8}>
              <Typography.Text>清晰度</Typography.Text>
              <Select
                mode="multiple"
                className="field-full"
                value={model.resolutions}
                disabled={props.disabled}
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
                disabled={props.disabled}
                options={(
                  getDefaultVideoPlazaModelOptions(model.id)?.aspect_ratios ?? model.aspect_ratios
                ).map((value) => ({ value, label: value }))}
                onChange={(aspect_ratios) => patchModelOptions(index, { aspect_ratios })}
              />
            </Col>
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
                    disabled={props.disabled}
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

export function ImagePlazaTagsEditor(props: {
  value: ImagePlazaTagConfig;
  disabled?: boolean;
  onChange: (value: ImagePlazaTagConfig) => void;
}) {
  // 业务 ID 可编辑，不能用作 React key；行标识只属于 UI，不进入保存的配置。
  const [rowKeys, setRowKeys] = useState(() => props.value.map(() => crypto.randomUUID()));
  if (rowKeys.length !== props.value.length) {
    setRowKeys(props.value.map(() => crypto.randomUUID()));
  }
  const validation = ImagePlazaTagConfigSchema.safeParse(props.value);
  const update = (index: number, patch: Partial<ImagePlazaTagConfig[number]>) => {
    const next = structuredClone(props.value);
    next[index] = { ...next[index], ...patch };
    props.onChange(next);
  };
  const updateGroup = (
    index: number,
    patch: Pick<
      Partial<ImagePlazaTagConfig[number]>,
      'group_label' | 'group_sort_order' | 'group_layout'
    >
  ) => {
    const groupId = props.value[index]?.group_id;
    props.onChange(
      props.value.map((tag) => (tag.group_id === groupId ? { ...tag, ...patch } : tag))
    );
  };
  const moveToGroup = (index: number, groupId: string) => {
    const existing = props.value.find(
      (tag, itemIndex) => itemIndex !== index && tag.group_id === groupId
    );
    update(index, {
      group_id: groupId,
      ...(existing
        ? {
            group_label: existing.group_label,
            group_sort_order: existing.group_sort_order,
            group_layout: existing.group_layout,
          }
        : {}),
    });
  };
  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Alert
        showIcon
        type="info"
        message="图片与视频共用同一标签目录"
        description="“全部”是系统固定项；筛选按标签名称模糊匹配 prompt_zh。相同分组 ID 会共享分组名称、顺序和布局。"
      />
      {!validation.success && (
        <Alert
          type="warning"
          showIcon
          message="请完善标签后保存，当前输入会保留"
          description={validation.error.issues.map((issue) => issue.message).join('；')}
        />
      )}
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
        <Card key={rowKeys[index]} size="small">
          <Row gutter={[12, 12]} align="middle">
            <Col xs={24} md={6}>
              <Input
                addonBefore="ID"
                aria-label={`标签 ${index + 1} ID`}
                value={tag.id}
                disabled={props.disabled}
                onChange={(event) => update(index, { id: event.target.value })}
              />
            </Col>
            <Col xs={24} md={6}>
              <Input
                addonBefore="名称"
                aria-label={`标签 ${index + 1} 名称`}
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
                addonBefore="标签顺序"
                min={0}
                precision={0}
                value={tag.sort_order}
                disabled={props.disabled}
                onChange={(sort_order) => update(index, { sort_order: sort_order ?? 0 })}
              />
            </Col>
            <Col xs={8} md={6}>
              <Button
                danger
                block
                disabled={props.disabled}
                onClick={() => {
                  setRowKeys((current) => current.filter((_, itemIndex) => itemIndex !== index));
                  props.onChange(props.value.filter((_, itemIndex) => itemIndex !== index));
                }}
              >
                删除
              </Button>
            </Col>
            <Col xs={24} md={6}>
              <Input
                addonBefore="分组 ID"
                aria-label={`标签 ${index + 1} 分组 ID`}
                value={tag.group_id}
                disabled={props.disabled}
                onChange={(event) => moveToGroup(index, event.target.value)}
              />
            </Col>
            <Col xs={24} md={6}>
              <Input
                addonBefore="分组名称"
                aria-label={`标签 ${index + 1} 分组名称`}
                value={tag.group_label}
                disabled={props.disabled}
                onChange={(event) => updateGroup(index, { group_label: event.target.value })}
              />
            </Col>
            <Col xs={12} md={6}>
              <InputNumber
                addonBefore="分组顺序"
                className="field-full"
                min={0}
                precision={0}
                value={tag.group_sort_order}
                disabled={props.disabled}
                onChange={(group_sort_order) =>
                  updateGroup(index, { group_sort_order: group_sort_order ?? 0 })
                }
              />
            </Col>
            <Col xs={12} md={6}>
              <Select
                aria-label={`标签 ${index + 1} 分组布局`}
                className="field-full"
                value={tag.group_layout}
                disabled={props.disabled}
                options={[
                  { value: 'chips', label: '标签流式布局' },
                  { value: 'grid', label: '卡片网格布局' },
                ]}
                onChange={(group_layout) => updateGroup(index, { group_layout })}
              />
            </Col>
          </Row>
        </Card>
      ))}
      <Button
        block
        disabled={props.disabled}
        onClick={() => {
          const previous = props.value.at(-1);
          setRowKeys((current) => [...current, crypto.randomUUID()]);
          props.onChange([
            ...props.value,
            {
              id: `tag-${Date.now()}`,
              label: '新标签',
              enabled: true,
              sort_order: props.value.length,
              group_id: previous?.group_id ?? 'style',
              group_label: previous?.group_label ?? '风格',
              group_sort_order: previous?.group_sort_order ?? 0,
              group_layout: previous?.group_layout ?? 'chips',
            },
          ]);
        }}
      >
        添加标签
      </Button>
    </Space>
  );
}
