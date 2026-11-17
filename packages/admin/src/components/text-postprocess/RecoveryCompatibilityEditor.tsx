import { Button, Input, Space, Switch, Typography } from 'antd';
import type { RichReplyRecovery } from '@miniapp/shared';

export function RecoveryCompatibilityEditor(props: {
  value: RichReplyRecovery;
  disabled: boolean;
  onChange: (value: RichReplyRecovery) => void;
}) {
  return (
    <Space direction="vertical" className="field-full">
      <Space wrap>
        <Switch
          aria-label="兼容外层代码围栏"
          checked={props.value.unwrap_code_fences}
          disabled={props.disabled}
          onChange={(checked) => props.onChange({ ...props.value, unwrap_code_fences: checked })}
        />
        <span>识别整块包住协议模块的代码围栏</span>
      </Space>
      <Typography.Text type="secondary">
        仅移除协议模块外层的围栏，普通代码块保持原样。标准方括号始终可用；以下额外括号只用于识别协议标签。
      </Typography.Text>
      {props.value.bracket_pairs.map((pair, index) => (
        <Space key={index} wrap>
          <Input
            aria-label={`左括号 ${index + 1}`}
            value={pair.open}
            maxLength={4}
            disabled={props.disabled}
            onChange={(event) =>
              props.onChange({
                ...props.value,
                bracket_pairs: props.value.bracket_pairs.map((item, at) =>
                  at === index ? { ...item, open: event.target.value } : item
                ),
              })
            }
          />
          <Input
            aria-label={`右括号 ${index + 1}`}
            value={pair.close}
            maxLength={4}
            disabled={props.disabled}
            onChange={(event) =>
              props.onChange({
                ...props.value,
                bracket_pairs: props.value.bracket_pairs.map((item, at) =>
                  at === index ? { ...item, close: event.target.value } : item
                ),
              })
            }
          />
          <Button
            disabled={props.disabled}
            onClick={() =>
              props.onChange({
                ...props.value,
                bracket_pairs: props.value.bracket_pairs.filter((_, at) => at !== index),
              })
            }
          >
            删除括号对
          </Button>
        </Space>
      ))}
      <Button
        disabled={props.disabled || props.value.bracket_pairs.length >= 8}
        onClick={() =>
          props.onChange({
            ...props.value,
            bracket_pairs: [...props.value.bracket_pairs, { open: '（', close: '）' }],
          })
        }
      >
        添加括号对
      </Button>
    </Space>
  );
}
