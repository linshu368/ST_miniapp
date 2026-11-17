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
import {
  QUALITY_MIN_TURNS,
  QUALITY_WINDOW_TURNS,
  type FreeZoneConfig,
  type FreeZoneOnShelf,
  type FreeZoneRelist,
  type FreeZoneScreening,
} from '@miniapp/shared';
import {
  asFreeZoneConfig,
  describeFreeZoneStatus,
  freeZoneIssues,
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
    key: 'max_interrupted_pct',
    label: '中断率上限（%）',
    hint: `开始出字后没写完就断（不含用户点停），占它自己交付轮次的比例。超过就下架并停着，点「立即上架」才回来；留空不检查`,
    max: 100,
    precision: 1,
  },
  {
    key: 'max_unusable_pct',
    label: '不可用率上限（%）',
    hint: '超时兜底 + 超时：等到「启动兜底等待」还没出字，或最后什么都没收到。报错、空回复后立刻兜底的不算。超过就下架并停着；留空不检查',
    max: 100,
    precision: 1,
  },
  {
    key: 'max_unroutable_pct',
    label: '派不出去率上限（%）',
    hint: '真实请求被 Surplus 拒绝派单（折扣底线达不到、没有卖家）的比例。不等评估：最近 20 次主请求里至少 10 次有响应、超过就当场下架，算价格原因（冷却后报价回来自动上架）；留空不检查',
    max: 100,
    precision: 1,
  },
];

const RELIST_FIELDS: ReadonlyArray<NumberField<'price_cooldown_minutes'>> = [
  {
    key: 'price_cooldown_minutes',
    label: '价格原因下架后冷却（分钟）',
    hint: '官方报价不达标、探测或真实请求派不出去而下架后，多久再评估；之后每 30 分钟一轮，报价达标就上架',
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
      <StatusSection value={value} disabled={props.disabled} onChange={update} />
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
        title="在架质量"
        hint={`每 30 分钟评估时，看这次上架之后最近 ${QUALITY_WINDOW_TURNS} 轮（至少 ${QUALITY_MIN_TURNS} 轮才判断）。中断率、不可用率越线是质量原因：直接下架并停着。派不出去是价格原因：冷却后报价回来自动上架。`}
      >
        <NumberFields
          value={value.on_shelf}
          fields={ON_SHELF_FIELDS}
          disabled={props.disabled}
          onChange={(patch) => update({ on_shelf: { ...value.on_shelf, ...patch } })}
        />
      </Section>
      <Section
        title="上架与冷却"
        hint="每 30 分钟评估一次：没在架的报价达标（含派单探测）就上架；在架的报价不达标就换同档其他供应商，都不行才下架。"
      >
        <NumberFields
          value={relist}
          fields={RELIST_FIELDS}
          disabled={props.disabled}
          onChange={updateRelist}
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
