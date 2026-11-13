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
import type {
  FreeZoneConfig,
  FreeZoneOnShelf,
  FreeZoneRelist,
  FreeZoneScreening,
} from '@miniapp/shared';
import {
  asFreeZoneConfig,
  describeFreeZoneStatus,
  freeZoneIssues,
  parseMinutesList,
  toPeriodTime,
} from '../lib/freeZoneForm';
import { FreeZoneScreeningOptions } from './FreeZoneScreeningOptions';
import { FreeZoneCandidatesEditor } from './FreeZoneCandidatesEditor';
import { FreeZoneScreeningPanel } from './FreeZoneScreeningPanel';
import { FreeZoneStatusPanel } from './FreeZoneStatusPanel';

interface NumberField<K extends string> {
  key: K;
  label: string;
  hint: string;
  /** 必填项不能留空；其余留空表示这一项不检查 */
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
}

const TTFT_BUCKETS = 'Surplus 首字是分档值（1670/2254/3043/4108/5546/7487），门槛要设在档位之上';

const SCREENING_FIELDS: ReadonlyArray<NumberField<keyof FreeZoneScreening & string>> = [
  {
    key: 'min_discount_pct',
    label: '折扣底线（%）',
    hint: '只看折扣不低于它的报价；同时作为发给 Surplus 的请求折扣底线',
    required: true,
    min: 1,
    max: 100,
  },
  {
    key: 'min_qualified_offers',
    label: '达标报价数',
    hint: '达到折扣底线、可用且健康的报价，每家供应商至少这么多',
    min: 1,
  },
  {
    key: 'min_realized_discount_pct',
    label: '7 天成交折扣（%）',
    hint: '这个模型近 7 天实际成交的平均折扣下限',
    max: 100,
    precision: 1,
  },
  {
    key: 'min_uptime_pct',
    label: '成功率（%）',
    hint: '供应商近 24 小时成功率下限',
    max: 100,
    precision: 1,
  },
  { key: 'max_ttft_p50_ms', label: '首字 p50 上限（毫秒）', hint: TTFT_BUCKETS, min: 1 },
  { key: 'max_ttft_p90_ms', label: '首字 p90 上限（毫秒）', hint: TTFT_BUCKETS, min: 1 },
  { key: 'min_tps', label: '出字速度（tokens/秒）', hint: '供应商 tps p50 下限' },
  {
    key: 'min_cache_hit_rate_pct',
    label: '缓存命中率（%）',
    hint: '供应商近 24 小时缓存命中率下限（Surplus 统计的是这家所有买家的）；命中低，同样的对话花得更多',
    max: 100,
    precision: 1,
  },
  { key: 'min_samples', label: '最少样本', hint: '供应商近 24 小时请求数不够就不算达标' },
  {
    key: 'price_band_ratio',
    label: '价格分档倍数',
    hint: '和最便宜那家差不到这个倍数的算同一档、挑首字最快的；更贵的档只在便宜档没人时用',
    required: true,
    min: 1,
    max: 100,
    step: 0.5,
    precision: 1,
  },
  {
    key: 'max_probe_ttft_ms',
    label: '探测首字上限（毫秒）',
    hint: '派单探测量到的首字超过它就算这家不达标；留空只记录、不卡',
    min: 1,
  },
];

const ON_SHELF_FIELDS: ReadonlyArray<NumberField<keyof FreeZoneOnShelf & string>> = [
  {
    key: 'window_hours',
    label: '统计窗口（小时）',
    hint: '看最近多久的真实轮次',
    required: true,
    min: 1,
    max: 168,
  },
  { key: 'min_turns', label: '最少轮数', hint: '样本不够这么多轮就不判断', required: true, min: 1 },
  {
    key: 'max_no_output_pct',
    label: '没出字率上限（%）',
    hint: '主模型一个字都没出',
    max: 100,
    precision: 1,
  },
  {
    key: 'max_fallback_delivered_pct',
    label: '兜底交付率上限（%）',
    hint: '最后交给用户的是兜底模型写的回复',
    max: 100,
    precision: 1,
  },
  {
    key: 'max_timeout_pct',
    label: '超时率上限（%）',
    hint: '用户最后什么都没收到',
    max: 100,
    precision: 1,
  },
  {
    key: 'max_ttft_p90_ms',
    label: '真实首字 p90 上限（毫秒）',
    hint: '主模型在我们流量上的首字',
    min: 1,
  },
  { key: 'max_refusal_pct', label: '拒答率上限（%）', hint: '留空不检查', max: 100, precision: 1 },
  {
    key: 'max_truncation_pct',
    label: '截断率上限（%）',
    hint: '留空不检查',
    max: 100,
    precision: 1,
  },
  {
    key: 'max_interrupted_pct',
    label: '生成中断率上限（%）',
    hint: '开始出字后没写完就断了，占它自己交付轮次的比例；不含用户点停；留空不检查',
    max: 100,
    precision: 1,
  },
  { key: 'max_dislike_pct', label: '点踩率上限（%）', hint: '留空不检查', max: 100, precision: 1 },
];

const RELIST_FIELDS: ReadonlyArray<NumberField<'required_passes' | 'cooldown_official_minutes'>> = [
  {
    key: 'required_passes',
    label: '连续达标次数',
    hint: '每 30 分钟评估一次，连续达标这么多次才上架',
    required: true,
    min: 1,
    max: 48,
  },
  {
    key: 'cooldown_official_minutes',
    label: '官方原因冷却（分钟）',
    hint: '因 Surplus 官方数据不达标下架后，多久内不再上架',
    required: true,
    max: 43_200,
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
            placeholder={field.required ? '必填' : '留空不检查'}
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

function MinutesListInput(props: {
  value: number[];
  disabled?: boolean;
  onChange: (value: number[]) => void;
}) {
  // 自己保留输入框原文，否则打到「1440, 」时逗号会被立刻吃掉。
  const [text, setText] = useState(() => props.value.join(', '));
  return (
    <Input
      value={text}
      placeholder="1440, 4320, 10080"
      disabled={props.disabled}
      onChange={(event) => {
        setText(event.target.value);
        props.onChange(parseMinutesList(event.target.value));
      }}
    />
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
          开放时栏目显示「结束时间 结束」；没到开始时间显示「开始时间
          开始」；过了结束时间栏目隐藏。要延长就改结束时间。
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

/** 候选池默认收起：几十个模型时不用一直往下翻。 */
function CandidatePool(props: {
  value: FreeZoneConfig['candidates'];
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

/** 运营平台「畅聊（免费模型）」：栏目开放、候选池、自动上下架门槛和首字参数。 */
export function FreeZoneConfigEditor(props: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: FreeZoneConfig) => void;
}) {
  const value = asFreeZoneConfig(props.value);
  const update = (patch: Partial<FreeZoneConfig>) => props.onChange({ ...value, ...patch });
  const issues = freeZoneIssues(value);
  const relist = value.relist;
  const updateRelist = (patch: Partial<FreeZoneRelist>) =>
    update({ relist: { ...relist, ...patch } });

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
      <Section title="线上状态">
        <FreeZoneStatusPanel />
      </Section>
      <CandidatePool
        value={value.candidates}
        disabled={props.disabled}
        onChange={(candidates) => update({ candidates })}
      />
      <Section
        title="官方数据初筛"
        hint="上架前用；在架后每 30 分钟用同一套门槛复核正在用的供应商。只看 Surplus 标为 trusted 的供应商。"
      >
        <FreeZoneScreeningOptions
          value={value.screening}
          disabled={props.disabled}
          onChange={(screening) => update({ screening })}
        />
        <NumberFields
          value={value.screening}
          fields={SCREENING_FIELDS}
          disabled={props.disabled}
          onChange={(patch) => update({ screening: { ...value.screening, ...patch } })}
        />
        <FreeZoneScreeningPanel config={value} />
      </Section>
      <Section
        title="在架业务数据"
        hint="只统计当前供应商开始用之后的轮次。越线就排除这家、换下一家达标供应商；所有供应商都不行才下架。"
      >
        <NumberFields
          value={value.on_shelf}
          fields={ON_SHELF_FIELDS}
          disabled={props.disabled}
          onChange={(patch) => update({ on_shelf: { ...value.on_shelf, ...patch } })}
        />
      </Section>
      <Section title="上架与冷却">
        <NumberFields
          value={relist}
          fields={RELIST_FIELDS}
          disabled={props.disabled}
          onChange={updateRelist}
        />
        <div>
          <Typography.Text>业务原因冷却梯度（分钟）</Typography.Text>
          <MinutesListInput
            value={relist.cooldown_business_minutes}
            disabled={props.disabled}
            onChange={(cooldown_business_minutes) => updateRelist({ cooldown_business_minutes })}
          />
          <Typography.Text type="secondary">
            7 天内第 1、2、3 次因业务数据下架，依次冷却这么久，超出取最后一个（1440 = 24 小时，10080
            = 7 天）。 业务越线被排除的供应商，排除时长取第一个值。
          </Typography.Text>
        </div>
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
