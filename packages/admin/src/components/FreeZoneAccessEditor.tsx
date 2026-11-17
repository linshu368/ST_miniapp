import dayjs from 'dayjs';
import {
  Col,
  DatePicker,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  TimePicker,
  Typography,
} from 'antd';
import { formatVipWeeklyWindow, freeZoneWeekdayLabel, type FreeZoneAccess } from '@miniapp/shared';
import { toPeriodTime } from '../lib/freeZoneForm';

const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  value: weekday,
  label: freeZoneWeekdayLabel(weekday),
}));

function Field(props: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <Col xs={24} md={12} lg={8}>
      <Typography.Text>{props.label}</Typography.Text>
      {props.children}
      <div>
        <Typography.Text type="secondary">{props.hint}</Typography.Text>
      </div>
    </Col>
  );
}

type AccessProps = {
  value: FreeZoneAccess;
  disabled?: boolean;
  update: (patch: Partial<FreeZoneAccess>) => void;
};

function TrialFields({ value, disabled, update }: AccessProps) {
  return (
    <>
      <Field label="新人试用：这之后注册的用户" hint="留空表示不开新人试用；试用从注册时间算">
        <DatePicker
          className="field-full"
          showTime={{ format: 'HH:mm' }}
          format="YYYY-MM-DD HH:mm"
          allowClear
          disabled={disabled}
          value={value.trial_since ? dayjs(value.trial_since) : null}
          onChange={(next) => update({ trial_since: next ? toPeriodTime(next) : null })}
        />
      </Field>
      <Field label="新人试用时长（小时）" hint="注册起多少小时内可以用">
        <InputNumber
          className="field-full"
          min={1}
          max={720}
          precision={0}
          disabled={disabled}
          value={value.trial_hours}
          onChange={(next) => update({ trial_hours: next ?? value.trial_hours })}
        />
      </Field>
      <Field label="会员开通礼（天）" hint="开通或续费起多少天可以用；0 表示不送">
        <InputNumber
          className="field-full"
          min={0}
          max={31}
          precision={0}
          disabled={disabled}
          value={value.vip_welcome_days}
          onChange={(next) => update({ vip_welcome_days: next ?? value.vip_welcome_days })}
        />
      </Field>
    </>
  );
}

function VipDayFields({ value, disabled, update }: AccessProps) {
  const weekly = value.vip_weekly;
  const startClock = dayjs().startOf('day').add(weekly.start_minute, 'minute');
  return (
    <>
      <Field label="会员畅聊日：周几" hint="北京时间">
        <Select
          className="field-full"
          options={WEEKDAY_OPTIONS}
          disabled={disabled}
          value={weekly.weekday}
          onChange={(weekday: number) => update({ vip_weekly: { ...weekly, weekday } })}
        />
      </Field>
      <Field label="会员畅聊日：开始时间" hint="当天几点开始">
        <TimePicker
          className="field-full"
          format="HH:mm"
          allowClear={false}
          disabled={disabled}
          value={startClock}
          onChange={(next) =>
            next
              ? update({
                  vip_weekly: { ...weekly, start_minute: next.hour() * 60 + next.minute() },
                })
              : undefined
          }
        />
      </Field>
      <Field label="会员畅聊日：时长（小时）" hint="可以跨到第二天，例如 15 小时到次日 03:00">
        <InputNumber
          className="field-full"
          min={0.5}
          max={168}
          step={0.5}
          precision={1}
          disabled={disabled}
          value={weekly.duration_minutes / 60}
          onChange={(next) =>
            next
              ? update({ vip_weekly: { ...weekly, duration_minutes: Math.round(next * 60) } })
              : undefined
          }
        />
      </Field>
    </>
  );
}

function PromptFields({ value, disabled, update }: AccessProps) {
  const prompt = value.prompt;
  const set = (patch: Partial<FreeZoneAccess['prompt']>) =>
    update({ prompt: { ...prompt, ...patch } });
  return (
    <Row gutter={[16, 16]}>
      <Field label="两次最短间隔（天）" hint="同一个用户两次弹窗至少隔这么久">
        <InputNumber
          className="field-full"
          min={0}
          max={90}
          precision={0}
          disabled={disabled}
          value={prompt.min_interval_days}
          onChange={(next) => set({ min_interval_days: next ?? prompt.min_interval_days })}
        />
      </Field>
      <Field label="每批次数" hint="连续弹满这么多次就进入冷却">
        <InputNumber
          className="field-full"
          min={1}
          max={10}
          precision={0}
          disabled={disabled}
          value={prompt.batch_size}
          onChange={(next) => set({ batch_size: next ?? prompt.batch_size })}
        />
      </Field>
      <Field label="每批之后冷却（天）" hint="任意这么多天内不超过「每批次数」">
        <InputNumber
          className="field-full"
          min={0}
          max={365}
          precision={0}
          disabled={disabled}
          value={prompt.batch_cooldown_days}
          onChange={(next) => set({ batch_cooldown_days: next ?? prompt.batch_cooldown_days })}
        />
      </Field>
    </Row>
  );
}

/**
 * 福利期外按身份开放：新人试用、会员开通礼、会员每周畅聊日，以及 VIP 弹窗频次。
 * 时间都按北京时间；开关关着时只有福利期，其余参数不生效。
 */
export function FreeZoneAccessEditor(props: {
  value: FreeZoneAccess;
  disabled?: boolean;
  onChange: (value: FreeZoneAccess) => void;
}) {
  const { value, disabled } = props;
  const update = (patch: Partial<FreeZoneAccess>) => props.onChange({ ...value, ...patch });
  const fieldProps = { value, disabled, update };
  return (
    <Space orientation="vertical" size="middle" className="editor-stack">
      <Space>
        <Switch
          checked={value.enabled}
          disabled={disabled}
          onChange={(enabled) => update({ enabled })}
        />
        <Typography.Text strong>
          {value.enabled ? '福利期外按身份开放' : '关闭：福利期外栏目隐藏'}
        </Typography.Text>
      </Space>
      <Typography.Text type="secondary">
        对用户关闭时（试用到期、畅聊日结束），选着免费模型的照常生成，直接换成付费默认模型并在对话里提示。
      </Typography.Text>
      <Row gutter={[16, 16]}>
        <TrialFields {...fieldProps} />
        <VipDayFields {...fieldProps} />
      </Row>
      <Typography.Text>会员畅聊日：每{formatVipWeeklyWindow(value.vip_weekly)}</Typography.Text>
      <Typography.Text strong>VIP 弹窗频次</Typography.Text>
      <Typography.Text type="secondary">
        会员期间、新人试用期内不弹。新人试用或福利期刚结束：被切到付费的那一轮之后弹一次；畅聊日开放时：非会员打开就弹。
      </Typography.Text>
      <PromptFields {...fieldProps} />
    </Space>
  );
}
