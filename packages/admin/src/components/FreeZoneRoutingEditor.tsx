import { InputNumber, Select, Typography } from 'antd';
import type { FreeZoneScreening } from '@miniapp/shared';

/** 同一个渠道只留一份（大小写不同也算同一个），去掉首尾空格。 */
function normalize(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** 折扣底线与屏蔽渠道。 */
export function FreeZoneRoutingEditor(props: {
  value: FreeZoneScreening;
  disabled?: boolean;
  onChange: (value: FreeZoneScreening) => void;
}) {
  const { value, onChange } = props;
  return (
    <>
      <div>
        <Typography.Text strong>统一折扣底线（%）</Typography.Text>
        <InputNumber
          className="field-full"
          min={1}
          max={100}
          precision={0}
          value={(value.min_discount_pct as number | null) ?? null}
          placeholder="必填"
          disabled={props.disabled}
          onChange={(next) => onChange({ ...value, min_discount_pct: next as number })}
        />
        <Typography.Text type="secondary">
          发给 Surplus
          的请求只接受折扣不低于它的卖家，达不到就拒单、由兜底回答；上架时也按它选供应商。模型单独设了底线的按模型的。
        </Typography.Text>
      </div>
      <div>
        <Typography.Text strong>屏蔽渠道</Typography.Text>
        <Select
          mode="tags"
          className="field-full"
          value={value.blocked_providers}
          disabled={props.disabled}
          placeholder="输入 Surplus 供应商名后回车，如 dashscope-cn"
          tokenSeparators={[',', '，', ' ']}
          notFoundContent={null}
          onChange={(next: string[]) => onChange({ ...value, blocked_providers: normalize(next) })}
        />
        <Typography.Text type="secondary">
          上架时不选这些供应商，也不能手动指定。已经在架、正用着它的模型不会自动换，要换就下架后重新上架。
        </Typography.Text>
      </div>
    </>
  );
}
