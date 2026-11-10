import {
  DEFAULT_STORY_MEMORY_CONFIG,
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
