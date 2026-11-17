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
import type { ImagePlazaModelCatalog, ImagePlazaPricingFactors } from '@miniapp/shared';
import {
  calculateImagePlazaPrice,
  getImagePlazaPricingFactors,
  imagePlazaPriceKey,
  IMAGE_PLAZA_PRICING_INPUT_MAX,
  recalculateImagePlazaCatalog,
  updateImagePlazaPricingFactor,
} from '../lib/imagePlazaPricing';

const FACTOR_FIELDS = [
  { key: 'exchange', label: '统一汇率', prefix: '汇率' },
  { key: 'markup', label: '统一加价倍率', prefix: '加价倍率' },
  { key: 'ratio', label: '每元星尘数', suffix: '星尘 = 1 元' },
] as const;

export function ImagePlazaPricingEditor(props: {
  value: ImagePlazaModelCatalog;
  disabled?: boolean;
  onChange: (value: ImagePlazaModelCatalog) => void;
}) {
  const { message } = AntApp.useApp();
  const factors = getImagePlazaPricingFactors(props.value);
  const standardPrices = props.value.standard_prices ?? {};
  const recalculated = recalculateImagePlazaCatalog(props.value, standardPrices, factors);
  const example = props.value.models
    .flatMap((model) =>
      model.resolutions.map((tier) => {
        const usd = standardPrices[imagePlazaPriceKey(model.id, tier.id)];
        return { model, tier, usd, price: calculateImagePlazaPrice(usd, factors) };
      })
    )
    .find((entry) => entry.price);
  const patchFactor = (key: keyof ImagePlazaPricingFactors, value: number | null) => {
    const next = updateImagePlazaPricingFactor(props.value, key, value);
    if (next) props.onChange(next);
    else message.warning('定价参数必须大于 0、最多四位小数；本次无效输入未保存，请重新填写。');
  };
  return (
    <>
      <Card size="small" title="统一定价参数（随目录保存与发布）">
        <Space direction="vertical" className="editor-stack">
          <Typography.Text type="secondary">
            USD
            标准价和统一参数随“保存草稿”保存，发布后成为线上目录的一部分；重新打开会读取保存的值。
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
                props.onChange({ ...recalculated.catalog, pricing_factors: factors });
                message.success('已重算所有模型档位的上架价；请保存草稿并发布后生效。');
              }}
            >
              一键重算
            </Button>
          </Space>
          <Typography.Text type="secondary">
            尾数不足 10
            星尘自动向上补整十。修改参数只更新预览，点击重算才会覆盖上架价草稿（包括手工价格）。空值或无效参数不保存，保留上次有效值。
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
            {example?.price
              ? `${example.model.name} / ${example.tier.label} (${example.tier.id})：${example.usd} × ${factors.exchange} × ${factors.markup} × ${factors.ratio} = ${example.price.raw} → ${example.price.credits} 星尘`
              : '填写至少一个档位的有效 USD 标准价和统一参数后显示实时示例。'}
          </Descriptions.Item>
          <Descriptions.Item label="换算">
            {factors.ratio} 星尘 = 1 元人民币；此比例只用于图片目录定价，不修改钱包或充值配置。
          </Descriptions.Item>
          <Descriptions.Item label="生效">
            参数与上架价一起保存并发布；扣费仍按已发布上架价，历史订单不回溯。
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </>
  );
}
