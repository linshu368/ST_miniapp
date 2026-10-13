import { Alert, Input, Space, Typography } from 'antd';
import type { InstructionSlotRules } from '@miniapp/shared';

/**
 * The runtime schema is owned by Shared.  This component deliberately owns
 * only the form layout so all save/publish validation continues through the
 * shared schema selected by the managed-config registry.
 */
export function PlatformInstructionSlotRulesEditor(props: {
  value: InstructionSlotRules;
  onChange: (value: InstructionSlotRules) => void;
  disabled?: boolean;
}) {
  const fields = [
    [
      'on_first_two_turns',
      '开启后前两轮：完整规则',
      '从 false → true 生效后的当前逻辑轮和下一轮使用。',
    ],
    ['on_later_turns', '开启后后续轮：简洁规则', '从第 3 个逻辑轮起使用；同轮重生成不会重新计数。'],
    ['off', '关闭规则', '关闭时注入本段规则，且不得输出对应机器标签。'],
  ] as const;

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Alert
        type="info"
        showIcon
        message="三个阶段均为可发布运营文案"
        description="保存草稿不会生效；发布或回滚会创建该槽位的新版本。不要在这里写入运行计数、模式快照或其他槽位内容。"
      />
      {fields.map(([key, label, hint]) => (
        <div key={key}>
          <Typography.Text strong>{label}</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ margin: '4px 0 8px' }}>
            {hint}
          </Typography.Paragraph>
          <Input.TextArea
            aria-label={label}
            rows={10}
            value={props.value[key]}
            disabled={props.disabled}
            onChange={(event) => props.onChange({ ...props.value, [key]: event.target.value })}
          />
        </div>
      ))}
    </Space>
  );
}
