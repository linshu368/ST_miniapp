import type {
  ImagePlazaPricingFactors,
  ProviderVideoPlazaModel,
  VideoPlazaModelCatalog,
} from '@miniapp/shared';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  InputNumber,
  Space,
  Typography,
} from 'antd';
import { IMAGE_PLAZA_PRICING_INPUT_MAX } from '../lib/imagePlazaPricing';
import {
  calculateVideoPlazaPrice,
  getVideoPlazaPricingFactors,
  recalculateVideoPlazaCatalog,
  updateVideoPlazaPricingFactor,
  videoPlazaPriceKey,
  videoPlazaTierLabel,
  VIDEO_PLAZA_PRICE_MAX,
} from '../lib/videoPlazaPricing';

type EditorProps = {
  value: VideoPlazaModelCatalog;
  disabled?: boolean;
  onChange: (value: VideoPlazaModelCatalog) => void;
};

const FACTOR_FIELDS = [
  { key: 'exchange', label: '统一汇率', prefix: '汇率' },
  { key: 'markup', label: '统一加价倍率', prefix: '加价倍率' },
  { key: 'ratio', label: '每元星尘数', suffix: '星尘 = 1 元' },
] as const;

export function VideoPlazaPricingEditor(props: EditorProps) {
  const { message } = AntApp.useApp();
  const factors = getVideoPlazaPricingFactors(props.value);
  const recalculated = recalculateVideoPlazaCatalog(props.value);
  const patchFactor = (key: keyof ImagePlazaPricingFactors, value: number | null) => {
    if (props.disabled) return;
    const next = updateVideoPlazaPricingFactor(props.value, key, value);
    if (next) props.onChange(next);
    else message.warning('定价参数必须大于 0、不超过 1,000,000，最多四位小数；无效输入未保存。');
  };
  return (
    <>
      <Card size="small" title="统一定价参数（随目录保存与发布）">
        <Space direction="vertical" className="editor-stack">
          <Typography.Text type="secondary">
            USD
            标准价和统一参数随“保存草稿”保存，发布后成为视频目录的一部分；重新打开会读取保存的值。
          </Typography.Text>
          {!props.value.pricing_factors && (
            <Alert
              type="info"
              showIcon
              message="此旧目录尚未保存统一参数，当前显示初始值；修改参数或重算后可随草稿保存。"
            />
          )}
          <Space wrap>
            <Typography.Text strong>原平台价 USD ×</Typography.Text>
            {FACTOR_FIELDS.map((field) => (
              <InputNumber
                key={field.key}
                aria-label={field.label}
                addonBefore={'prefix' in field ? field.prefix : undefined}
                addonAfter={'suffix' in field ? field.suffix : undefined}
                min={0.0001}
                max={IMAGE_PLAZA_PRICING_INPUT_MAX}
                precision={4}
                value={factors[field.key]}
                disabled={props.disabled}
                onChange={(value) => patchFactor(field.key, value)}
              />
            ))}
            <Button
              type="primary"
              disabled={props.disabled || !recalculated.catalog}
              onClick={() => {
                if (props.disabled || !recalculated.catalog) return;
                props.onChange(recalculated.catalog);
                message.success('已重算所有视频模型档位；请保存草稿并发布后生效。');
              }}
            >
              一键重算
            </Button>
          </Space>
          <Typography.Text type="secondary">
            尾数不足 10
            星尘向上补整十。修改参数只更新预览；点击重算才覆盖上架价草稿（包括手工价格）。无效参数不保存，保留上次有效值。
          </Typography.Text>
          {recalculated.issues.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`暂不能批量重算：${recalculated.issues.length} 个档位缺少有效标准价或结果超出范围`}
              description={`请检查：${recalculated.issues.join('；')}。USD 标准价最多四位小数；计算后上架价不得超过 1,000,000 星尘。`}
            />
          )}
        </Space>
      </Card>
      <VideoPricingFormula value={props.value} />
    </>
  );
}

function VideoPricingFormula({ value }: Pick<EditorProps, 'value'>) {
  const factors = getVideoPlazaPricingFactors(value);
  const example = value.models
    .flatMap((model) =>
      Object.keys(model.price_matrix).map((key) => {
        const usd = value.standard_prices?.[videoPlazaPriceKey(model.id, key)];
        return { model, key, usd, price: calculateVideoPlazaPrice(usd, factors) };
      })
    )
    .find((entry) => entry.price);
  return (
    <Card size="small" title="定价公式预览">
      <Descriptions column={1} size="small">
        <Descriptions.Item label="公式">
          星尘价 = 向上补整十（USD × 汇率 × 加价倍率 × 每元星尘数）
        </Descriptions.Item>
        <Descriptions.Item label="示例">
          {example?.price
            ? `${example.model.name} / ${videoPlazaTierLabel(example.key)}：${example.usd} × ${factors.exchange} × ${factors.markup} × ${factors.ratio} = ${example.price.raw} → ${example.price.credits} 星尘`
            : '填写至少一个档位的有效 USD 标准价后显示实时示例。'}
        </Descriptions.Item>
        <Descriptions.Item label="换算">
          {factors.ratio} 星尘 = 1 元人民币；此比例只用于视频目录定价，不修改钱包或充值配置。
        </Descriptions.Item>
        <Descriptions.Item label="生效">
          参数与上架价一起保存并发布；扣费仍按已发布上架价，历史订单不回溯。
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

export function VideoModelPricingEditor(props: EditorProps & { model: ProviderVideoPlazaModel }) {
  const factors = getVideoPlazaPricingFactors(props.value);
  return (
    <Space direction="vertical" className="editor-stack">
      {Object.entries(props.model.price_matrix).map(([key, credits]) => {
        const standardKey = videoPlazaPriceKey(props.model.id, key);
        return (
          <VideoPricingRow
            key={key}
            label={`${props.model.name} / ${videoPlazaTierLabel(key)}`}
            credits={credits}
            usd={props.value.standard_prices?.[standardKey] ?? null}
            factors={factors}
            disabled={props.disabled}
            onUsdChange={(usd) => {
              if (props.disabled) return;
              props.onChange({
                ...props.value,
                standard_prices: { ...props.value.standard_prices, [standardKey]: usd },
              });
            }}
            onPriceChange={(price, recalculated) => {
              if (props.disabled) return;
              props.onChange({
                ...props.value,
                ...(recalculated ? { pricing_factors: factors } : {}),
                models: props.value.models.map((model) =>
                  model.id === props.model.id
                    ? { ...model, price_matrix: { ...model.price_matrix, [key]: price } }
                    : model
                ),
              });
            }}
          />
        );
      })}
    </Space>
  );
}

function VideoPricingRow(props: {
  label: string;
  credits: number;
  usd: number | null;
  factors: ImagePlazaPricingFactors;
  disabled?: boolean;
  onUsdChange: (value: number | null) => void;
  onPriceChange: (value: number, recalculated?: boolean) => void;
}) {
  const price = calculateVideoPlazaPrice(props.usd, props.factors);
  return (
    <Card size="small">
      <Space wrap>
        <Typography.Text strong>{props.label}</Typography.Text>
        <InputNumber
          aria-label={`${props.label} USD 标准价`}
          addonBefore="USD 标准价"
          placeholder="填写平台标准价"
          min={0.0001}
          max={IMAGE_PLAZA_PRICING_INPUT_MAX}
          precision={4}
          value={props.usd}
          disabled={props.disabled}
          onChange={props.onUsdChange}
        />
        <Typography.Text type="secondary">
          {price
            ? `预览：${price.raw} → ${price.credits} 星尘`
            : '请填写有效标准价及统一参数，结果不得超过 1,000,000 星尘'}
        </Typography.Text>
        <Button
          disabled={props.disabled || !price}
          onClick={() => {
            if (!props.disabled && price) props.onPriceChange(price.credits, true);
          }}
        >
          重算
        </Button>
        <InputNumber
          aria-label={`${props.label} 上架星尘价`}
          addonBefore="上架价"
          min={1}
          max={VIDEO_PLAZA_PRICE_MAX}
          precision={1}
          value={props.credits}
          disabled={props.disabled}
          onChange={(value) => props.onPriceChange(value ?? 1)}
        />
      </Space>
    </Card>
  );
}
