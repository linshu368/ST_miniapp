import { Alert, Input, Space, Tag, Typography } from 'antd';
import { SystemInstructionsSchema } from '../lib/configSchemas';

const PLACEHOLDERS = [
  '{{WORD_COUNT}}',
  '{{INTERACTION_MODE}}',
  '{{USER_CUSTOM_INSTRUCTIONS}}',
] as const;

export function SystemInstructionsEditor(props: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const parsed = SystemInstructionsSchema.safeParse(props.value);
  const missing = PLACEHOLDERS.filter((placeholder) => !props.value.includes(placeholder));

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Alert
        type="info"
        showIcon
        message="Markdown 平台规则"
        description="保存/发布为新快照，不覆盖历史。三个占位符会在每轮生成时按用户偏好替换。"
      />
      <div>
        <Typography.Text>占位符</Typography.Text>
        <div style={{ marginTop: 8 }}>
          <Space wrap>
            {PLACEHOLDERS.map((placeholder) => (
              <Tag
                key={placeholder}
                color={props.value.includes(placeholder) ? 'green' : 'red'}
                style={{ cursor: props.disabled ? 'default' : 'pointer' }}
                onClick={() => {
                  if (props.disabled) return;
                  if (props.value.includes(placeholder)) return;
                  props.onChange(`${props.value.trimEnd()}\n${placeholder}\n`);
                }}
              >
                {placeholder}
              </Tag>
            ))}
          </Space>
        </div>
      </div>
      {missing.length > 0 || !parsed.success ? (
        <Alert
          type="warning"
          showIcon
          message="发布前需补齐占位符"
          description={
            missing.length > 0
              ? `缺少：${missing.join('、')}`
              : parsed.success
                ? undefined
                : parsed.error.issues.map((issue) => issue.message).join('；')
          }
        />
      ) : null}
      <Input.TextArea
        value={props.value}
        disabled={props.disabled}
        rows={28}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Space>
  );
}
