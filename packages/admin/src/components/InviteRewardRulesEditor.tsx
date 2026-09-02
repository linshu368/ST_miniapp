import { Card, InputNumber, Space, Switch, Typography } from 'antd';
import { INVITE_RULE_KEY_LABELS, type InviteRewardRulesConfig } from '../lib/configSchemas';

interface InviteRewardRulesEditorProps {
  value: InviteRewardRulesConfig;
  disabled?: boolean;
  onChange: (value: InviteRewardRulesConfig) => void;
}

export function InviteRewardRulesEditor(props: InviteRewardRulesEditorProps) {
  const updateRule = (index: number, patch: Partial<InviteRewardRulesConfig['rules'][number]>) => {
    const rules = props.value.rules.map((rule, ruleIndex) =>
      ruleIndex === index ? { ...rule, ...patch } : rule
    );
    props.onChange({ ...props.value, rules });
  };

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Card size="small" title="累计奖励上限">
        <Space direction="vertical" size="small">
          <InputNumber
            min={1}
            precision={0}
            value={props.value.total_cap_credits}
            disabled={props.disabled}
            addonAfter="星尘"
            onChange={(cap) => props.onChange({ ...props.value, total_cap_credits: cap ?? 1 })}
          />
          <Typography.Text type="secondary">
            单个下级用户带来的累计奖励封顶值；触及上限时发奖 RPC 会截断本次金额。
          </Typography.Text>
        </Space>
      </Card>

      <Card size="small" title="奖励规则">
        <Space direction="vertical" size="middle" className="field-full">
          <Typography.Text type="secondary">
            rule_key 一经发布不可改名或删除（发放流水引用它做幂等键）；金额与开关可随时调整并发布。
          </Typography.Text>
          {props.value.rules.map((rule, index) => (
            <Card size="small" type="inner" key={rule.rule_key}>
              <Space size="large" wrap align="center">
                <div>
                  <Typography.Text strong>
                    {INVITE_RULE_KEY_LABELS[rule.rule_key] ?? '自定义规则'}
                  </Typography.Text>
                  <br />
                  <Typography.Text code>{rule.rule_key}</Typography.Text>
                </div>
                <div>
                  <Typography.Text>奖励星尘</Typography.Text>
                  <br />
                  <InputNumber
                    min={1}
                    precision={0}
                    value={rule.credits}
                    disabled={props.disabled}
                    onChange={(credits) => updateRule(index, { credits: credits ?? 1 })}
                  />
                </div>
                <div>
                  <Typography.Text>启用</Typography.Text>
                  <br />
                  <Switch
                    checked={rule.enabled}
                    disabled={props.disabled}
                    onChange={(enabled) => updateRule(index, { enabled })}
                  />
                </div>
              </Space>
            </Card>
          ))}
        </Space>
      </Card>
    </Space>
  );
}
