import { useState } from 'react';
import { Alert, Input, InputNumber, Space, Switch, Typography } from 'antd';
import {
  ChatRecoveryConfigSchema,
  INITIAL_CHAT_RECOVERY_CONFIG,
  type ChatRecoveryConfig,
} from '@miniapp/shared';

/** 出字后兜底（中断或拒答 → 擦掉重写）的开关、时限与拒答词池（一行一个）。 */
export function ChatRecoveryConfigEditor(props: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: ChatRecoveryConfig) => void;
}) {
  const parsed = ChatRecoveryConfigSchema.safeParse(props.value);
  // 保留运营正在输入的值；不合法时只提示，不替换
  const raw =
    props.value && typeof props.value === 'object' && !Array.isArray(props.value)
      ? (props.value as Partial<ChatRecoveryConfig>)
      : {};
  const value: ChatRecoveryConfig = {
    ...INITIAL_CHAT_RECOVERY_CONFIG,
    ...raw,
    interruption: { ...INITIAL_CHAT_RECOVERY_CONFIG.interruption, ...raw.interruption },
    refusal: { ...INITIAL_CHAT_RECOVERY_CONFIG.refusal, ...raw.refusal },
  };
  const set = (patch: Partial<ChatRecoveryConfig>) => props.onChange({ ...value, ...patch });
  // 输入框保留原文（含正在敲的空行），保存的是去空白、去空行后的词池
  const [keywordsText, setKeywordsText] = useState(value.refusal.keywords.join('\n'));
  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      {!parsed.success ? (
        <Alert type="error" showIcon message={parsed.error.issues[0]?.message ?? '配置不合法'} />
      ) : null}
      <Typography.Text type="secondary">
        回复已经开始出字后出问题时，擦掉这条回复已显示的内容（含思考过程），用首字兜底同一个模型从头重写一次（兜底不再兜底）。救回来的轮次正常扣费，没救回来的按中断免扣。涉及未成年人时系统固定不兜底，这里不能改。
      </Typography.Text>

      <label className="field-full">
        <Typography.Text strong>兜底模型出首字时限（毫秒）</Typography.Text>
        <InputNumber
          min={1000}
          max={20000}
          step={500}
          value={value.fallback_first_token_ms}
          disabled={props.disabled}
          onChange={(next) => set({ fallback_first_token_ms: Number(next ?? 3000) })}
        />
        <Typography.Text type="secondary">兜底模型在这个时间内没出第一个字就放弃。</Typography.Text>
      </label>

      <Typography.Title level={5}>中断重写</Typography.Title>
      <Space>
        <Switch
          checked={value.interruption.enabled}
          disabled={props.disabled}
          onChange={(enabled) => set({ interruption: { ...value.interruption, enabled } })}
        />
        <Typography.Text>开启</Typography.Text>
      </Space>
      <label className="field-full">
        <Typography.Text strong>多久没有新字算中断（毫秒）</Typography.Text>
        <InputNumber
          min={1000}
          max={60000}
          step={500}
          value={value.interruption.stall_ms}
          disabled={props.disabled}
          onChange={(next) =>
            set({ interruption: { ...value.interruption, stall_ms: Number(next ?? 3000) } })
          }
        />
        <Typography.Text type="secondary">
          出字后连续这么久没有新字（正文或显示中的思考）就判中断，擦掉重写。慢但没断的回复也会被判中断。
        </Typography.Text>
      </label>

      <Typography.Title level={5}>拒答重写</Typography.Title>
      <Space>
        <Switch
          checked={value.refusal.enabled}
          disabled={props.disabled}
          onChange={(enabled) => set({ refusal: { ...value.refusal, enabled } })}
        />
        <Typography.Text>开启（词池为空时不生效）</Typography.Text>
      </Space>
      <label className="field-full">
        <Typography.Text strong>只在正文前多少个字里检查</Typography.Text>
        <InputNumber
          min={5}
          max={200}
          value={value.refusal.check_chars}
          disabled={props.disabled}
          onChange={(next) =>
            set({ refusal: { ...value.refusal, check_chars: Number(next ?? 30) } })
          }
        />
      </label>
      <label className="field-full">
        <Typography.Text strong>拒答词池（一行一个）</Typography.Text>
        <Input.TextArea
          autoSize={{ minRows: 6, maxRows: 20 }}
          value={keywordsText}
          disabled={props.disabled}
          onChange={(event) => {
            setKeywordsText(event.target.value);
            set({
              refusal: {
                ...value.refusal,
                keywords: event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
              },
            });
          }}
        />
        <Typography.Text type="secondary">
          正文照常输出；这段里出现任一词（不区分大小写）即判拒答，擦掉后由兜底模型重写。不要放「抱歉」这类剧情里也常见的词。
        </Typography.Text>
      </label>
    </Space>
  );
}
