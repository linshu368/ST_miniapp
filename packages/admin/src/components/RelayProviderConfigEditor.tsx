import { Alert, Card, Input, InputNumber, Space, Switch, Typography } from 'antd';
import {
  DEFAULT_LLM_RELAY_PROVIDER_CONFIG,
  LlmRelayProviderConfigSchema,
  RelayProviderPolicySchema,
  type LlmRelayProviderConfig,
  type RelayProviderPolicy,
} from '@miniapp/shared';

// Keep an incomplete conversion draft visible; the shared publication schema enforces provenance.
const EditableRelayConfigSchema = LlmRelayProviderConfigSchema.extend({
  packy: RelayProviderPolicySchema.innerType(),
  onexmodel: RelayProviderPolicySchema.innerType(),
});

export function RelayProviderConfigEditor(props: {
  value: unknown;
  onChange(value: unknown): void;
  disabled?: boolean;
}) {
  const parsed = EditableRelayConfigSchema.safeParse(props.value);
  const value: LlmRelayProviderConfig = parsed.success
    ? parsed.data
    : DEFAULT_LLM_RELAY_PROVIDER_CONFIG;
  const numeric = ['quota_per_unit', 'cny_per_unit', 'usd_per_cny', 'low_balance_quota'] as const;
  const labels = {
    quota_per_unit: '每平台单位的 quota',
    cny_per_unit: '每平台单位实付 CNY',
    usd_per_cny: '每 CNY 对应 USD',
    low_balance_quota: '低余额阈值（quota）',
  };
  return (
    <Space direction="vertical" className="field-full">
      <Alert
        type="info"
        message="平台额度不是美元。只填写已核验的换算；留空表示未知。新策略默认关闭。"
      />
      {(['packy', 'onexmodel'] as const).map((provider) => {
        const update = (patch: Partial<RelayProviderPolicy>) =>
          props.onChange({ ...value, [provider]: { ...value[provider], ...patch } });
        return (
          <Card key={provider} title={provider} size="small">
            <Space direction="vertical" className="field-full">
              {numeric.map((key) => (
                <Space key={key}>
                  <Typography.Text>{labels[key]}</Typography.Text>
                  <InputNumber
                    min={key === 'low_balance_quota' ? 0 : 0.000000001}
                    value={value[provider][key]}
                    disabled={props.disabled}
                    onChange={(number) => update({ [key]: number })}
                  />
                </Space>
              ))}
              <Input
                placeholder="换算依据版本"
                value={value[provider].conversion_version ?? ''}
                maxLength={64}
                disabled={props.disabled}
                onChange={(event) => update({ conversion_version: event.target.value || null })}
              />
              <Input
                placeholder="换算依据来源（不含凭证）"
                value={value[provider].conversion_source ?? ''}
                maxLength={256}
                disabled={props.disabled}
                onChange={(event) => update({ conversion_source: event.target.value || null })}
              />
              <Space>
                <Typography.Text>启用低余额监控</Typography.Text>
                <Switch
                  checked={value[provider].monitor_enabled}
                  disabled={props.disabled}
                  onChange={(monitor_enabled) => update({ monitor_enabled })}
                />
              </Space>
            </Space>
          </Card>
        );
      })}
    </Space>
  );
}
