import { Input, Select, Space, Switch, Typography } from 'antd';
import type { RichReplyRecovery } from '@miniapp/shared';

type RecoveryTag = 'choices' | 'status' | 'memory';

export function RecoveryTagEditor(props: {
  tag: RecoveryTag;
  value: RichReplyRecovery;
  disabled: boolean;
  onChange: (value: RichReplyRecovery) => void;
}) {
  const names = { choices: '选项', status: '状态栏', memory: '记忆区' } as const;
  const tagValue = props.value[props.tag];
  return (
    <Space direction="vertical" className="field-full">
      <Space wrap>
        <Switch
          aria-label={`${names[props.tag]}末尾补全`}
          checked={tagValue.recover_at_eof}
          disabled={props.disabled}
          onChange={(checked) =>
            props.onChange({
              ...props.value,
              [props.tag]: { ...tagValue, recover_at_eof: checked },
            })
          }
        />
        <span>缺少结束标签时，在回复末尾收口为卡片</span>
      </Space>
      {props.tag === 'choices' ? (
        <Typography.Text type="secondary">
          至少一个完整有效选项即可点击；不完整或空选项不生成发送动作。副标题可用 {'{count}'}{' '}
          显示实际数量。
        </Typography.Text>
      ) : null}
      {(['title', 'subtitle', 'fallback_title', 'fallback_subtitle'] as const).map((field) => (
        <label key={field} className="text-postprocess-field">
          <span>
            {
              {
                title: '标题',
                subtitle: '副标题',
                fallback_title: '降级标题',
                fallback_subtitle: '降级副标题',
              }[field]
            }
          </span>
          <Input
            aria-label={`${names[props.tag]}${field}`}
            value={tagValue[field]}
            disabled={props.disabled}
            maxLength={field.endsWith('subtitle') ? 160 : 80}
            onChange={(event) =>
              props.onChange({
                ...props.value,
                [props.tag]: { ...tagValue, [field]: event.target.value },
              })
            }
          />
        </label>
      ))}
      <label className="text-postprocess-field">
        <span>额外标签别名（保留标准标签 {props.tag}，最多 8 个）</span>
        <Select
          mode="tags"
          aria-label={`${names[props.tag]}标签别名`}
          value={props.value.tag_aliases[props.tag]}
          disabled={props.disabled}
          onChange={(aliases: string[]) =>
            props.onChange({
              ...props.value,
              tag_aliases: { ...props.value.tag_aliases, [props.tag]: aliases },
            })
          }
        />
      </label>
      {props.tag === 'choices' ? (
        <label className="text-postprocess-field">
          <span>单个选项的额外标签别名（保留 choice，最多 8 个）</span>
          <Select
            mode="tags"
            aria-label="单个选项标签别名"
            value={props.value.tag_aliases.choice}
            disabled={props.disabled}
            onChange={(aliases: string[]) =>
              props.onChange({
                ...props.value,
                tag_aliases: { ...props.value.tag_aliases, choice: aliases },
              })
            }
          />
        </label>
      ) : null}
    </Space>
  );
}
