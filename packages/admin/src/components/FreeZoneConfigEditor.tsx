import { useState, type ReactNode } from 'react';
import dayjs from 'dayjs';
import {
  Alert,
  Card,
  Col,
  Collapse,
  DatePicker,
  Input,
  InputNumber,
  Radio,
  Row,
  Space,
  Switch,
  Typography,
} from 'antd';
import type { FreeZoneConfig, FreeZoneUsageLimit } from '@miniapp/shared';
import {
  asFreeZoneConfig,
  describeFreeZoneStatus,
  freeZoneIssues,
  toPeriodTime,
} from '../lib/freeZoneForm';
import { FreeZoneAccessEditor } from './FreeZoneAccessEditor';
import { FreeZoneRoutingEditor } from './FreeZoneRoutingEditor';
import { FreeZoneCandidatesEditor } from './FreeZoneCandidatesEditor';
import { FreeZoneStatusPanel } from './FreeZoneStatusPanel';

interface NumberField<K extends string> {
  key: K;
  label: string;
  hint: string;
  /** 必填项不能留空；其余留空表示不限 */
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
}

const USAGE_LIMIT_FIELDS: ReadonlyArray<NumberField<keyof FreeZoneUsageLimit & string>> = [
  {
    key: 'turns_per_24h',
    label: '每人每天上限（轮）',
    hint: '模型自己没设上限时用这个；留空不限。只数成功的轮次（含重新生成），北京时间每天 12 点清零',
    min: 1,
    max: 5000,
  },
];

function NumberFields<T extends object>(props: {
  value: T;
  fields: ReadonlyArray<NumberField<keyof T & string>>;
  disabled?: boolean;
  onChange: (patch: Partial<T>) => void;
}) {
  return (
    <Row gutter={[16, 16]}>
      {props.fields.map((field) => (
        <Col xs={24} md={12} lg={8} key={field.key}>
          <Typography.Text>{field.label}</Typography.Text>
          <InputNumber
            className="field-full"
            min={field.min ?? 0}
            max={field.max}
            step={field.step ?? 1}
            precision={field.precision ?? 0}
            value={(props.value[field.key] as number | null | undefined) ?? null}
            placeholder={field.required ? '必填' : '留空不限'}
            disabled={props.disabled}
            onChange={(next) => props.onChange({ [field.key]: next ?? null } as Partial<T>)}
          />
          <div>
            <Typography.Text type="secondary">{field.hint}</Typography.Text>
          </div>
        </Col>
      ))}
    </Row>
  );
}

function Section(props: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card size="small" title={props.title}>
      <Space orientation="vertical" size="middle" className="editor-stack">
        {props.hint ? <Typography.Text type="secondary">{props.hint}</Typography.Text> : null}
        {props.children}
      </Space>
    </Card>
  );
}

/** 线上状态；每个模型的「折扣底线」和在架模型的「并发」直接改表单里的候选池。 */
function StatusSection(props: {
  value: FreeZoneConfig;
  disabled?: boolean;
  onChange: (patch: Partial<FreeZoneConfig>) => void;
}) {
  return (
    <Section title="线上状态">
      <FreeZoneStatusPanel
        editing={{
          candidates: props.value.candidates,
          defaultDiscountPct: props.value.screening.min_discount_pct,
          defaultTurnLimit: props.value.usage_limit.turns_per_24h,
          disabled: props.disabled,
          onChange: (candidates) => props.onChange({ candidates }),
        }}
      />
    </Section>
  );
}

function OpenSettings(props: {
  value: FreeZoneConfig;
  disabled?: boolean;
  onChange: (patch: Partial<FreeZoneConfig>) => void;
}) {
  const { value } = props;
  const status = describeFreeZoneStatus(value, new Date());
  const period = value.period;
  return (
    <Space orientation="vertical" size="middle" className="editor-stack">
      <Alert type={status.type} showIcon title={status.text} />
      <Space>
        <Switch
          checked={value.enabled}
          disabled={props.disabled}
          onChange={(enabled) => props.onChange({ enabled })}
        />
        <Typography.Text strong>{value.enabled ? '栏目已开启' : '栏目已关闭'}</Typography.Text>
      </Space>
      <div>
        <Typography.Text>福利期</Typography.Text>
        <DatePicker.RangePicker
          className="field-full"
          showTime={{ format: 'HH:mm' }}
          format="YYYY-MM-DD HH:mm"
          placeholder={['开始时间', '结束时间']}
          disabled={props.disabled}
          value={period ? [dayjs(period.starts_at), dayjs(period.ends_at)] : null}
          onChange={(range) => {
            const [start, end] = range ?? [];
            props.onChange({
              period:
                start && end
                  ? { starts_at: toPeriodTime(start), ends_at: toPeriodTime(end) }
                  : null,
            });
          }}
        />
        <Typography.Text type="secondary">
          福利期内所有人都能用：栏目显示「结束时间 结束」；没到开始时间显示「开始时间
          开始」。过了结束时间：按身份开放关着就隐藏，开着就按下面的规则。
        </Typography.Text>
      </div>
      <div>
        <Typography.Text>使用范围</Typography.Text>
        <div>
          <Radio.Group
            value={value.scope}
            disabled={props.disabled}
            onChange={(event) => props.onChange({ scope: event.target.value })}
            options={[
              { value: 'all_cards', label: '所有角色卡' },
              { value: 'own_cards', label: '只限用户自己创作的角色卡' },
            ]}
          />
        </div>
        <Typography.Text type="secondary">
          只限自创卡时，别人的卡上照样显示栏目和规则，标「仅限自创角色卡」，不能选。
        </Typography.Text>
      </div>
      <div>
        <Typography.Text>规则文字</Typography.Text>
        <Input.TextArea
          value={value.rules_text}
          maxLength={200}
          showCount
          autoSize={{ minRows: 3, maxRows: 6 }}
          placeholder="显示在栏目卡头，可以换行，最多显示三行"
          disabled={props.disabled}
          onChange={(event) => props.onChange({ rules_text: event.target.value })}
        />
      </div>
    </Space>
  );
}

/** 全局每人每天上限；模型单独的上限在候选池、线上状态和模型目录里设。 */
function UsageLimitSection(props: {
  value: FreeZoneUsageLimit;
  disabled?: boolean;
  onChange: (value: FreeZoneUsageLimit) => void;
}) {
  return (
    <Section
      title="用量上限"
      hint="防个别用户一直猛聊拖垮成本：每个免费模型每人每天最多几轮（北京时间 12 点清零，不放 0 点是为了不让晚上猛聊的人凌晨再拿一份）。模型单独设了（候选池、线上状态、模型目录「免费畅聊」板块）按它的，没设按这里。用满后发消息时自动换同系列、再换其他没用满的免费模型，都用满了换付费默认模型，并在那条回复下轻提示一句；栏目里这个模型显示「次数已用完」和恢复时间。"
    >
      <NumberFields
        value={props.value}
        fields={USAGE_LIMIT_FIELDS}
        disabled={props.disabled}
        onChange={(patch) => props.onChange({ ...props.value, ...patch })}
      />
    </Section>
  );
}

/** 候选池默认收起：几十个模型时不用一直往下翻。 */
function CandidatePool(props: {
  value: FreeZoneConfig['candidates'];
  defaultTurnLimit: number | null;
  disabled?: boolean;
  onChange: (value: FreeZoneConfig['candidates']) => void;
}) {
  return (
    <Section title={`候选池（${props.value.length}/50）`}>
      <Collapse
        size="small"
        items={[
          {
            key: 'pool',
            label: `展开编辑候选池（${props.value.length} 个）`,
            children: (
              <FreeZoneCandidatesEditor
                value={props.value}
                defaultTurnLimit={props.defaultTurnLimit}
                disabled={props.disabled}
                onChange={props.onChange}
              />
            ),
          },
        ]}
      />
    </Section>
  );
}

/** 运营平台「畅聊（免费模型）」：栏目开放、候选池与上下架、折扣底线、上限和首字参数。 */
export function FreeZoneConfigEditor(props: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: FreeZoneConfig) => void;
}) {
  const value = asFreeZoneConfig(props.value);
  const update = (patch: Partial<FreeZoneConfig>) => props.onChange({ ...value, ...patch });
  const issues = freeZoneIssues(value);

  return (
    <Space orientation="vertical" size="middle" className="editor-stack">
      {issues.length > 0 ? (
        <Alert
          type="error"
          showIcon
          title="下面这些参数不合法，改好才能保存"
          description={
            <ul>
              {issues.slice(0, 8).map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          }
        />
      ) : null}
      <Section title="栏目开放">
        <OpenSettings value={value} disabled={props.disabled} onChange={update} />
      </Section>
      <Section title="福利期外按身份开放（新人试用 / 会员）">
        <FreeZoneAccessEditor
          value={value.access}
          disabled={props.disabled}
          onChange={(access) => update({ access })}
        />
      </Section>
      <StatusSection value={value} disabled={props.disabled} onChange={update} />
      <CandidatePool
        value={value.candidates}
        defaultTurnLimit={value.usage_limit.turns_per_24h}
        disabled={props.disabled}
        onChange={(candidates) => update({ candidates })}
      />
      <UsageLimitSection
        value={value.usage_limit}
        disabled={props.disabled}
        onChange={(usage_limit) => update({ usage_limit })}
      />
      <Section title="折扣底线与屏蔽渠道">
        <FreeZoneRoutingEditor
          value={value.screening}
          disabled={props.disabled}
          onChange={(screening) => update({ screening })}
        />
      </Section>
      <Section
        title="首字（只对免费模型生效）"
        hint="付费档的首字和兜底参数不受影响。兜底模型仍是兜底配置里的那个。"
      >
        <NumberFields
          value={value.first_token}
          fields={[
            {
              key: 'primary_wait_ms',
              label: '启动兜底等待（毫秒）',
              hint: '主模型等这么久还没出字就同时启动兜底',
              required: true,
              min: 1,
            },
            {
              key: 'deadline_ms',
              label: '首字总上限（毫秒）',
              hint: '必须比启动兜底等待更长',
              required: true,
              min: 1,
            },
          ]}
          disabled={props.disabled}
          onChange={(patch) => update({ first_token: { ...value.first_token, ...patch } })}
        />
      </Section>
    </Space>
  );
}
