import { Card, Input, InputNumber, Space, Typography } from 'antd';
import {
  VIP_PLAN_BONUS_CREDITS_MAX,
  VIP_PLAN_DURATION_DAYS_MAX,
  VIP_PLAN_PRICE_CENTS_MAX,
  type VipPlanTerms,
  type VipCheckinBonusConfig,
  splitVipCheckinReward,
  VIP_CHECKIN_FIXED_CREDITS_MAX,
} from '@miniapp/shared';
import { blankToNull, vipPriceLabel, withPlanPatch } from '../lib/vipStrategyForm';

export function PlanEditor(props: {
  label: string;
  value: VipPlanTerms;
  disabled: boolean;
  lockBonus: boolean;
  onChange: (next: VipPlanTerms) => void;
}) {
  return (
    <Card type="inner" title={props.label}>
      <Space direction="vertical" size="small" className="editor-stack">
        <Typography.Text>标题</Typography.Text>
        <Input
          maxLength={40}
          disabled={props.disabled}
          value={props.value.title}
          onChange={(event) =>
            props.onChange(withPlanPatch(props.value, { title: event.target.value }))
          }
        />
        <Typography.Text>说明</Typography.Text>
        <Input
          maxLength={200}
          disabled={props.disabled}
          value={props.value.description ?? ''}
          onChange={(event) =>
            props.onChange(
              withPlanPatch(props.value, { description: blankToNull(event.target.value) })
            )
          }
        />
        <Typography.Text>角标</Typography.Text>
        <Input
          maxLength={40}
          disabled={props.disabled}
          value={props.value.badge_text ?? ''}
          onChange={(event) =>
            props.onChange(
              withPlanPatch(props.value, { badge_text: blankToNull(event.target.value) })
            )
          }
        />
        <Typography.Text>价格（分）</Typography.Text>
        <InputNumber
          min={1}
          max={VIP_PLAN_PRICE_CENTS_MAX}
          precision={0}
          disabled={props.disabled}
          value={props.value.price_cents}
          addonAfter="分"
          onChange={(next) => {
            if (typeof next === 'number') {
              props.onChange(withPlanPatch(props.value, { price_cents: next }));
            }
          }}
        />
        <Typography.Text type="secondary">
          页面展示 {vipPriceLabel(props.value.price_cents)}
        </Typography.Text>
        <Typography.Text>有效天数</Typography.Text>
        <InputNumber
          min={1}
          max={VIP_PLAN_DURATION_DAYS_MAX}
          precision={0}
          disabled={props.disabled}
          value={props.value.duration_days}
          onChange={(next) => {
            if (typeof next === 'number') {
              props.onChange(withPlanPatch(props.value, { duration_days: next }));
            }
          }}
        />
        <Typography.Text>赠送专项星尘</Typography.Text>
        <InputNumber
          min={0}
          max={VIP_PLAN_BONUS_CREDITS_MAX}
          precision={0}
          disabled={props.disabled || props.lockBonus}
          value={props.lockBonus ? 0 : props.value.bonus_credits}
          onChange={(next) => {
            if (!props.lockBonus && typeof next === 'number') {
              props.onChange(withPlanPatch(props.value, { bonus_credits: next }));
            }
          }}
        />
        <Typography.Text>赠送通用星尘</Typography.Text>
        <InputNumber
          min={0}
          max={VIP_PLAN_BONUS_CREDITS_MAX}
          precision={0}
          disabled={props.disabled || props.lockBonus}
          value={props.value.bonus_main_credits ?? 0}
          onChange={(next) => {
            if (!props.lockBonus && typeof next === 'number')
              props.onChange(withPlanPatch(props.value, { bonus_main_credits: next }));
          }}
        />
        {props.lockBonus ? (
          <Typography.Text type="secondary">周卡赠送固定为 0，不能在这里修改。</Typography.Text>
        ) : null}
      </Space>
    </Card>
  );
}

export function CheckinRewardEditor({
  value,
  disabled,
  onChange,
}: {
  value: VipCheckinBonusConfig;
  disabled: boolean;
  onChange: (value: VipCheckinBonusConfig) => void;
}) {
  const checkin = splitVipCheckinReward(value);
  return (
    <Space direction="vertical">
      {(['bonus_credits', 'main_credits'] as const).map((key) => (
        <div key={key}>
          <Typography.Text>
            {key === 'bonus_credits' ? 'VIP 每日签到专项星尘' : 'VIP 每日签到通用星尘'}
          </Typography.Text>
          <div>
            <InputNumber
              min={0}
              max={VIP_CHECKIN_FIXED_CREDITS_MAX}
              precision={0}
              disabled={disabled}
              value={checkin[key]}
              addonAfter="星尘"
              onChange={(next) => {
                if (typeof next === 'number') onChange({ ...checkin, [key]: next });
              }}
            />
          </div>
        </div>
      ))}
    </Space>
  );
}
