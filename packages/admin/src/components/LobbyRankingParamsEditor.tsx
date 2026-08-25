import { Alert, Card, Col, InputNumber, Row, Select, Space, Typography } from 'antd';
import { DEFAULT_LOBBY_RANKING_PARAMS, type LobbyRankingParams } from '@miniapp/shared';

/** 数字项的展示元数据。step 用来让分位点、权重这类小数不必手打小数点 */
interface NumberField {
  key: NumberFieldKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  step?: number;
  precision?: number;
}

type NumberFieldKey = Exclude<keyof LobbyRankingParams, 'first_touch_lookback_days'>;

const SAMPLING_FIELDS: NumberField[] = [
  {
    key: 'window_days',
    label: '统计窗口（天）',
    hint: '太长会让老卡吃几个月前的老本，太短则样本方差大、排名天天抖',
    min: 1,
    max: 365,
  },
  {
    key: 'turn_cap',
    label: '轮次上限 cap',
    hint: '单人单卡最多按这么多轮计分。30 是沉浸阈值，也与付费行为挂钩；有它重度用户拉不爆整卡均值',
    min: 1,
    max: 1000,
  },
  {
    key: 'session_gap_minutes',
    label: '会话切分间隔（分钟）',
    hint: '相邻两条消息超过它就算新会话。「两次会话至少隔这么久」是切分的自然结果，无需另设条件',
    min: 1,
    max: 1440,
  },
  {
    key: 'return_window_hours',
    label: '回访窗口（小时）',
    hint: 'R48 的定义。同时也是分母的观察期：首次会话结束还没满这么久的用户不计入',
    min: 1,
    max: 720,
  },
];

const THRESHOLD_FIELDS: NumberField[] = [
  {
    key: 'min_users',
    label: '主池硬门槛 X_D',
    hint: '窗口内去重用户数达到它才进主池按分排序，之下走冷启动随机插入。也是「成熟卡」的定义',
    min: 1,
    max: 1000000,
  },
  {
    key: 'r48_full_trust_sample',
    label: 'R48 软门槛 X_R',
    hint: '回访分母达到它才完全采信实测回访率，之下按比例向中性值回退。只影响可信度，不决定准入',
    min: 1,
    max: 1000000,
  },
  {
    key: 'd30_prior_weight',
    label: 'D30 收缩强度 m_D',
    hint: '贝叶斯先验的权重。样本量等于它时先验与实测各占一半；填 0 等于关闭收缩，小样本卡会靠运气冲榜',
    min: 0,
    max: 100000,
  },
];

const NORMALIZATION_FIELDS: NumberField[] = [
  {
    key: 'norm_percentile_low',
    label: '归一化低位分位',
    hint: '标尺下端，默认 P10。每次刷新按当天分布重算',
    min: 0,
    max: 1,
    step: 0.05,
    precision: 2,
  },
  {
    key: 'norm_percentile_high',
    label: '归一化高位分位',
    hint: '标尺上端，默认 P90。必须大于低位',
    min: 0,
    max: 1,
    step: 0.05,
    precision: 2,
  },
  {
    key: 'neutral_norm',
    label: 'R 中性值',
    hint: '样本不足、标尺不成立、冷启动无达标卡时取它。语义是「排在标尺正中间」，不奖不罚',
    min: 0,
    max: 1,
    step: 0.05,
    precision: 2,
  },
];

/** 权重和必须为 1，所以 R48 由 D30 推出，不单独给输入框 */
const WEIGHT_STEP = 0.05;

function asParams(value: unknown): LobbyRankingParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return structuredClone(DEFAULT_LOBBY_RANKING_PARAMS);
  }
  const record = value as Partial<LobbyRankingParams>;
  const merged = { ...structuredClone(DEFAULT_LOBBY_RANKING_PARAMS) };
  for (const key of Object.keys(merged) as Array<keyof LobbyRankingParams>) {
    const incoming = record[key];
    if (key === 'first_touch_lookback_days') {
      // null 是这一项的有效取值（不限回溯），不能被 ?? 吞掉
      if (incoming === null || typeof incoming === 'number') {
        merged.first_touch_lookback_days = incoming;
      }
      continue;
    }
    if (typeof incoming === 'number') merged[key] = incoming;
  }
  return merged;
}

function roundStep(value: number): number {
  return Math.round(value * 100) / 100;
}

export function LobbyRankingParamsEditor(props: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: LobbyRankingParams) => void;
}) {
  const params = asParams(props.value);

  const patch = (next: Partial<LobbyRankingParams>) => props.onChange({ ...params, ...next });

  const renderNumbers = (fields: readonly NumberField[]) => (
    <Row gutter={[12, 12]}>
      {fields.map((field) => (
        <Col xs={24} md={12} lg={8} key={field.key}>
          <Typography.Text>{field.label}</Typography.Text>
          <InputNumber
            className="field-full"
            min={field.min}
            max={field.max}
            step={field.step}
            precision={field.precision ?? 0}
            value={params[field.key]}
            disabled={props.disabled}
            onChange={(number) =>
              patch({ [field.key]: number ?? DEFAULT_LOBBY_RANKING_PARAMS[field.key] })
            }
          />
          <Typography.Text type="secondary">{field.hint}</Typography.Text>
        </Col>
      ))}
    </Row>
  );

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Alert
        type="info"
        showIcon
        message="改动在下一次排序刷新后生效（每 24 小时一轮，服务重启后 30 秒也会跑一轮）"
        description="推荐页的分数是离线算好落表的，不是每次请求现算。所以这里发布完不会立刻看到列表变化；同理，主池门槛也跟着分数一起落表，不会出现「分数按旧门槛算、分池按新门槛分」的中间态。"
      />

      <Card size="small" title="统计口径">
        {renderNumbers(SAMPLING_FIELDS)}
        <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
          <Col xs={24} md={12} lg={8}>
            <Typography.Text>首次接触回溯</Typography.Text>
            <Select
              className="field-full"
              value={params.first_touch_lookback_days === null ? 'unlimited' : 'bounded'}
              disabled={props.disabled}
              options={[
                { value: 'unlimited', label: '不限（回看全部历史）' },
                { value: 'bounded', label: '限定天数' },
              ]}
              onChange={(mode) =>
                patch({
                  first_touch_lookback_days: mode === 'unlimited' ? null : 90,
                })
              }
            />
            <Typography.Text type="secondary">
              判定 R48 分母里的「新客」时向窗口前回看多久。「不限」是精确解——聊天记录从不清理，
              所以全历史首触落在窗口内就是真新客。限定天数只是给「全表扫不动了」留的成本上界，
              代价是首触更早的老用户会被误判成新客混进分母，把 R48 拉低。
            </Typography.Text>
          </Col>
          {params.first_touch_lookback_days !== null ? (
            <Col xs={24} md={12} lg={8}>
              <Typography.Text>回溯天数</Typography.Text>
              <InputNumber
                className="field-full"
                min={1}
                max={3650}
                precision={0}
                value={params.first_touch_lookback_days}
                disabled={props.disabled}
                onChange={(number) => patch({ first_touch_lookback_days: number ?? 90 })}
              />
              <Typography.Text type="secondary">设计文档给的参考值是 90 天</Typography.Text>
            </Col>
          ) : null}
        </Row>
      </Card>

      <Card size="small" title="权重">
        <Row gutter={[12, 12]}>
          <Col xs={24} md={12} lg={8}>
            <Typography.Text>w1 — D30 深度权重</Typography.Text>
            <InputNumber
              className="field-full"
              min={0}
              max={1}
              step={WEIGHT_STEP}
              precision={2}
              value={params.d30_weight}
              disabled={props.disabled}
              onChange={(number) => {
                const d30 = roundStep(number ?? DEFAULT_LOBBY_RANKING_PARAMS.d30_weight);
                // 两项必须和为 1，否则分数不再是百分制、历史分数也没法比。
                // 与其让运营踩一次校验失败，不如直接由 w1 推出 w2。
                patch({ d30_weight: d30, r48_weight: roundStep(1 - d30) });
              }}
            />
            <Typography.Text type="secondary">主因素：30 轮深度分</Typography.Text>
          </Col>
          <Col xs={24} md={12} lg={8}>
            <Typography.Text>w2 — R48 回访权重</Typography.Text>
            <InputNumber className="field-full" value={params.r48_weight} disabled precision={2} />
            <Typography.Text type="secondary">
              次因素：48 小时回访率。由 w1 推出（两者和恒为 1）
            </Typography.Text>
          </Col>
        </Row>
      </Card>

      <Card size="small" title="样本门槛与收缩">
        {renderNumbers(THRESHOLD_FIELDS)}
      </Card>

      <Card size="small" title="归一化">
        <Typography.Paragraph type="secondary">
          D30 的典型分布在 0.2–0.5，R48 在 0.05–0.25。不先各自归一化就直接加权， R48
          的实际影响力只有名义权重的三分之一。
        </Typography.Paragraph>
        {renderNumbers(NORMALIZATION_FIELDS)}
      </Card>
    </Space>
  );
}
