import { LlmPricingConfigSchema } from '@miniapp/shared';
import { Col, InputNumber, Row, Typography } from 'antd';
import type { z } from 'zod';

type LlmPricingConfig = z.infer<typeof LlmPricingConfigSchema>;

const FALLBACK_FIXED_DEDUCTION: LlmPricingConfig['fixedDeduction'] = {
  freeQuotaExhausted: 10,
  light: 15,
  standard: 30,
  premium: 50,
};

const TIERS = [
  ['freeQuotaExhausted', '免费模型超出免费轮次'],
  ['light', '轻量档（付费）'],
  ['standard', '标准档'],
  ['premium', '旗舰档'],
] as const;

export function LlmPricingConfigEditor(props: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: LlmPricingConfig) => void;
}) {
  const parsed = LlmPricingConfigSchema.safeParse(props.value);
  const fixedDeduction = parsed.success ? parsed.data.fixedDeduction : FALLBACK_FIXED_DEDUCTION;
  return (
    <Row gutter={[12, 12]}>
      {TIERS.map(([key, label]) => (
        <Col xs={24} md={12} lg={6} key={key}>
          <Typography.Text>{label}（星尘/轮）</Typography.Text>
          <InputNumber
            min={0}
            className="field-full"
            value={fixedDeduction[key]}
            disabled={props.disabled}
            onChange={(number) =>
              props.onChange({ fixedDeduction: { ...fixedDeduction, [key]: number ?? 0 } })
            }
          />
        </Col>
      ))}
    </Row>
  );
}
