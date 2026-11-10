import { Alert, Card, Switch, Tabs, Typography } from 'antd';
import {
  DEFAULT_RICH_REPLY_RECOVERY,
  RichReplyRecoverySchema,
  type RichReplyRecovery,
} from '@miniapp/shared';
import { RecoveryCompatibilityEditor } from './RecoveryCompatibilityEditor';
import { RecoveryTagEditor } from './RecoveryTagEditor';

type RecoveryTag = 'choices' | 'status' | 'memory';

export function RecoveryEditor(props: {
  value: RichReplyRecovery | undefined;
  disabled: boolean;
  onChange: (value: RichReplyRecovery | undefined) => void;
}) {
  const value = props.value;
  const invalid = value !== undefined && !RichReplyRecoverySchema.safeParse(value).success;
  const names = { choices: '选项', status: '状态栏', memory: '记忆区' } as const;
  return (
    <Card
      size="small"
      title="解析与兜底"
      extra={
        <Switch
          aria-label="使用可配置兜底"
          checked={value !== undefined}
          disabled={props.disabled}
          onChange={(checked) =>
            props.onChange(checked ? structuredClone(DEFAULT_RICH_REPLY_RECOVERY) : undefined)
          }
        />
      }
    >
      {invalid ? (
        <Alert
          type="error"
          showIcon
          message="解析配置无效"
          description="别名只能包含字母、中文、下划线或连字符，不能与标准标签或其他别名重名，且每项最多 8 个。括号须为 1～4 个非字母数字、非空白的符号，不能含斜线、代码围栏或尖括号。请检查后再保存。"
        />
      ) : null}
      {!value ? (
        <Typography.Text type="secondary">
          当前沿用旧版内置解析。启用后可配置结尾补全、卡片文案、标签变体与代码围栏兼容；保存并发布后用于新回复。
        </Typography.Text>
      ) : (
        <Tabs
          items={[
            ...(['choices', 'status', 'memory'] as const).map((tag: RecoveryTag) => ({
              key: tag,
              label: names[tag],
              children: (
                <RecoveryTagEditor
                  tag={tag}
                  value={value}
                  disabled={props.disabled}
                  onChange={(next) => props.onChange(next)}
                />
              ),
            })),
            {
              key: 'compatibility',
              label: '格式兼容',
              children: (
                <RecoveryCompatibilityEditor
                  value={value}
                  disabled={props.disabled}
                  onChange={(next) => props.onChange(next)}
                />
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}
