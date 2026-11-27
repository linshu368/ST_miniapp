import type { ReactElement } from 'react';
import {
  MEMORY_BAR_PROMPT_KEY,
  MEMORY_BAR_PROMPT_MAX_CHARS,
  DEFAULT_STATUS_MEMORY_MODEL_CONFIG,
  DEFAULT_STORY_MEMORY_CONFIG,
  STATUS_MEMORY_MODEL_CONFIG_KEY,
  STORY_MEMORY_CONFIG_KEY,
  STORY_MEMORY_PROMPT_KEY,
  StatusMemoryModelConfigSchema,
  type StatusMemoryModelConfig,
  STORY_MEMORY_PROMPT_MAX_CHARS,
  StoryMemoryConfigSchema,
  extractStoryMemorySections,
  type StoryMemoryConfig,
} from '@miniapp/shared';
import { Alert, Col, Input, InputNumber, Row, Select, Space, Switch, Tag, Typography } from 'antd';

type NumberField = Exclude<
  {
    [Key in keyof StoryMemoryConfig]: StoryMemoryConfig[Key] extends number ? Key : never;
  }[keyof StoryMemoryConfig],
  undefined
>;

const NUMBER_FIELDS: ReadonlyArray<{
  key: NumberField;
  label: string;
  hint: string;
  step?: number;
}> = [
  { key: 'high_watermark_chars', label: '高水位（字）', hint: '窗口正文超过它触发截断' },
  { key: 'low_watermark_chars', label: '低水位（字）', hint: '截断后退到它以下' },
  { key: 'min_keep_turns', label: '保底轮数', hint: '最近这么多轮永不截断，至少 11' },
  { key: 'min_removable_turns', label: '最少可移除轮数', hint: '不足时不截断，避免频繁截断' },
  { key: 'memory_max_chars', label: '档案字数上限', hint: '超出即判为不合格' },
  { key: 'recent_context_turns', label: '附带近期轮数', hint: '压缩时只读参考的窗口末尾轮数' },
  { key: 'chunk_chars', label: '分块字数', hint: '待压缩章节超过它时分块迭代' },
  { key: 'temperature', label: '温度', hint: '压缩模型采样温度', step: 0.1 },
];

export function StoryMemoryConfigEditor(props: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: StoryMemoryConfig) => void;
}) {
  const parsed = StoryMemoryConfigSchema.safeParse(props.value);
  // Keep the operator's in-progress values; schema errors are shown, not discarded.
  const value: StoryMemoryConfig =
    props.value && typeof props.value === 'object' && !Array.isArray(props.value)
      ? { ...DEFAULT_STORY_MEMORY_CONFIG, ...(props.value as Partial<StoryMemoryConfig>) }
      : DEFAULT_STORY_MEMORY_CONFIG;
  const update = (patch: Partial<StoryMemoryConfig>) => props.onChange({ ...value, ...patch });

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      {!parsed.success ? (
        <Alert type="error" showIcon message={parsed.error.issues[0]?.message ?? '参数不合法'} />
      ) : null}
      <Space>
        <Switch
          checked={value.enabled}
          disabled={props.disabled}
          onChange={(enabled) => update({ enabled })}
        />
        <Typography.Text strong>{value.enabled ? '记忆已开启' : '记忆已关闭'}</Typography.Text>
        <Typography.Text type="secondary">关闭时停止生成与注入，截断照常。</Typography.Text>
      </Space>
      <Row gutter={[12, 12]}>
        {NUMBER_FIELDS.map((field) => (
          <Col xs={24} md={12} lg={6} key={field.key}>
            <Typography.Text>{field.label}</Typography.Text>
            <InputNumber
              className="field-full"
              min={0}
              step={field.step ?? 1}
              precision={field.step ? 1 : 0}
              value={value[field.key]}
              disabled={props.disabled}
              onChange={(number) => update({ [field.key]: number ?? 0 })}
            />
            <Typography.Text type="secondary">{field.hint}</Typography.Text>
          </Col>
        ))}
      </Row>
      <Row gutter={[12, 12]}>
        <Col xs={24} md={12}>
          <Typography.Text>压缩模型（OpenRouter 模型 ID）</Typography.Text>
          <Input
            value={value.model_id}
            disabled={props.disabled}
            onChange={(event) => update({ model_id: event.target.value })}
          />
        </Col>
        <Col xs={24} md={12}>
          <Typography.Text>供应商优先顺序（OpenRouter provider order）</Typography.Text>
          <Select
            mode="tags"
            className="field-full"
            value={value.preferred_providers}
            disabled={props.disabled}
            tokenSeparators={[',', '，', ' ']}
            placeholder="为空时交给 OpenRouter 默认路由"
            onChange={(providers: string[]) => update({ preferred_providers: providers })}
          />
        </Col>
      </Row>
    </Space>
  );
}

export function StoryMemoryPromptEditor(props: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const sections = extractStoryMemorySections(props.value);
  return (
    <Space direction="vertical" size="small" className="editor-stack">
      <Input.TextArea
        value={props.value}
        autoSize={{ minRows: 16, maxRows: 40 }}
        maxLength={STORY_MEMORY_PROMPT_MAX_CHARS}
        showCount
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <Typography.Text type="secondary">
        系统会校验输出必须包含以下 {sections.length} 个板块：
      </Typography.Text>
      <Space wrap size={[4, 4]}>
        {sections.map((section) => (
          <Tag key={section}>{section.replace(/^##\s*/, '')}</Tag>
        ))}
      </Space>
    </Space>
  );
}

/** 记忆栏 prompt：纯文本；输出结构由系统固定追加，这里只写记录规则。 */
export function MemoryBarPromptEditor(props: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Space direction="vertical" size="small" className="editor-stack">
      <Input.TextArea
        value={props.value}
        autoSize={{ minRows: 16, maxRows: 40 }}
        maxLength={MEMORY_BAR_PROMPT_MAX_CHARS}
        showCount
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <Typography.Text type="secondary">
        系统会在后面固定追加输出要求（record / milestones / compress / summary
        四个字段和字数上限），这里不用写，也不要改写它们的格式。
      </Typography.Text>
    </Space>
  );
}

const FALLBACK_PROVIDER_OPTIONS = [
  { value: 'surplus', label: 'Surplus' },
  { value: 'openrouter', label: 'OpenRouter' },
] as const;

/** 状态栏/记忆栏模型：首发（Surplus，记忆栏可单独配）和兜底（来源可选 OpenRouter / Surplus）模型名；通道和参数由系统固定。 */
export function StatusMemoryModelConfigEditor(props: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: StatusMemoryModelConfig) => void;
}) {
  const parsed = StatusMemoryModelConfigSchema.safeParse(props.value);
  // 保留运营正在输入的值；不合法时只提示，不替换
  const stored =
    props.value && typeof props.value === 'object' && !Array.isArray(props.value)
      ? (props.value as Partial<StatusMemoryModelConfig>)
      : null;
  const value: StatusMemoryModelConfig = stored
    ? {
        ...DEFAULT_STATUS_MEMORY_MODEL_CONFIG,
        ...stored,
        // 老配置没有来源键，按 OpenRouter（后端同样的规矩），不能吃默认值里的 surplus
        fallback_provider: stored.fallback_provider ?? 'openrouter',
      }
    : DEFAULT_STATUS_MEMORY_MODEL_CONFIG;
  const fallbackProvider = value.fallback_provider ?? 'openrouter';
  const fields = [
    {
      key: 'primary_model',
      label: '状态栏首发模型',
      hint: 'Surplus 上的模型名，如 gemini-3-flash-preview。流式调用，4 秒内没出第一个字就转兜底。',
    },
    {
      key: 'memory_primary_model',
      label: '记忆栏首发模型（Surplus，可不填）',
      hint: '只给记忆栏用的首发模型，如 deepseek-v4.1-flash-1017。不填就和上面的状态栏首发模型一样。',
    },
    {
      key: 'fallback_model',
      label: `兜底模型（${fallbackProvider === 'surplus' ? 'Surplus' : 'OpenRouter'}）`,
      hint:
        fallbackProvider === 'surplus'
          ? 'Surplus 上的模型名，如 deepseek-v4.1-flash-1017。供应商设置跟畅聊兜底一致（优先供应商、派单方式、价格带、屏蔽渠道都取畅聊页「畅聊兜底」），不设折扣底线。首发失败、超时或写得不合格时用它。'
          : 'OpenRouter 上的模型 ID，如 deepseek/deepseek-v4-flash。首发失败、超时或写得不合格时用它。',
    },
  ] as const;
  const update = (key: (typeof fields)[number]['key'], text: string) => {
    const next: StatusMemoryModelConfig = { ...value, [key]: text };
    // 可选项清空就去掉，表示「和状态栏一样」；留空字符串会过不了校验
    if (key === 'memory_primary_model' && !text.trim()) delete next.memory_primary_model;
    props.onChange(next);
  };
  const fallbackSource = (
    <div key="fallback_provider" className="field-full">
      <Typography.Text strong>兜底来源</Typography.Text>
      <Select
        className="field-full"
        value={fallbackProvider}
        disabled={props.disabled}
        options={[...FALLBACK_PROVIDER_OPTIONS]}
        onChange={(fallback_provider) => props.onChange({ ...value, fallback_provider })}
      />
      <Typography.Text type="secondary">
        换来源时请同时改下面的兜底模型名：OpenRouter 的写法是 deepseek/deepseek-v4-flash，Surplus
        的写法是 deepseek-v4.1-flash-1017。
      </Typography.Text>
    </div>
  );
  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      {!parsed.success ? (
        <Alert type="error" showIcon message={parsed.error.issues[0]?.message ?? '模型名不合法'} />
      ) : null}
      {fields.flatMap((field) => [
        ...(field.key === 'fallback_model' ? [fallbackSource] : []),
        <label key={field.key} className="field-full">
          <Typography.Text strong>{field.label}</Typography.Text>
          <Input
            value={value[field.key] ?? ''}
            disabled={props.disabled}
            maxLength={200}
            onChange={(event) => update(field.key, event.target.value)}
          />
          <Typography.Text type="secondary">{field.hint}</Typography.Text>
        </label>,
      ])}
      <Typography.Text type="secondary">
        状态栏和记忆栏共用首发（记忆栏单独配了除外）和兜底模型，不影响正文回复的首字兜底。模型名写错时，更新会失败或退回默认模型，发布前请确认平台上有这个模型。
      </Typography.Text>
    </Space>
  );
}

/** 长期记忆、记忆栏、状态栏/记忆栏模型这几项配置的编辑器；不是这几个 key 时返回 null。 */
export function memoryConfigEditor(props: {
  configKey: string;
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}): ReactElement | null {
  const text = typeof props.value === 'string' ? props.value : '';
  const common = { disabled: props.disabled, onChange: props.onChange };
  switch (props.configKey) {
    case STORY_MEMORY_CONFIG_KEY:
      return <StoryMemoryConfigEditor value={props.value} {...common} />;
    case STORY_MEMORY_PROMPT_KEY:
      return <StoryMemoryPromptEditor value={text} {...common} />;
    case MEMORY_BAR_PROMPT_KEY:
      return <MemoryBarPromptEditor value={text} {...common} />;
    case STATUS_MEMORY_MODEL_CONFIG_KEY:
      return <StatusMemoryModelConfigEditor value={props.value} {...common} />;
    default:
      return null;
  }
}
