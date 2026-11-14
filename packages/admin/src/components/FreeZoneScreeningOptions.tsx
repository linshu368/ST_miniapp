import { Select, Space, Switch, Typography } from 'antd';
import type { FreeZoneScreening } from '@miniapp/shared';

/** 同一个渠道只留一份（大小写不同也算同一个），去掉首尾空格。 */
function normalize(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** 屏蔽渠道：这些 Surplus 供应商上的所有模型都不参与竞争。 */
function BlockedProviders(props: {
  value: string[];
  disabled?: boolean;
  onChange: (value: string[]) => void;
}) {
  return (
    <div>
      <Typography.Text strong>屏蔽渠道</Typography.Text>
      <Select
        mode="tags"
        className="field-full"
        value={props.value}
        disabled={props.disabled}
        placeholder="输入 Surplus 供应商名后回车，如 dashscope-cn"
        tokenSeparators={[',', '，', ' ']}
        notFoundContent={null}
        onChange={(value: string[]) => props.onChange(normalize(value))}
      />
      <Typography.Text type="secondary">
        这些渠道上的所有模型都不参与初筛和挑供应商；在架模型下一轮复核（30
        分钟内）自动换到别家，没有别家就下架。
      </Typography.Text>
    </div>
  );
}

function ProbeSwitch(props: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <Space align="start">
      <Switch checked={props.enabled} disabled={props.disabled} onChange={props.onChange} />
      <div>
        <Typography.Text strong>派单探测{props.enabled ? '已开启' : '已关闭'}</Typography.Text>
        <div>
          <Typography.Text type="secondary">
            每 30
            分钟评估时，对在架和准备上架的模型，用选定的供应商带折扣底线真发一个只要几个字的请求；派不出去就换下一家或下架（订单簿上的折扣和派单时实际估算的不一定一样）。下面的「按当前门槛筛选」不发真实请求，不含这一项。
          </Typography.Text>
        </div>
      </div>
    </Space>
  );
}

/** 初筛里的两个开关类设置：派单探测、屏蔽渠道（数值门槛在下面的表单里）。 */
export function FreeZoneScreeningOptions(props: {
  value: FreeZoneScreening;
  disabled?: boolean;
  onChange: (value: FreeZoneScreening) => void;
}) {
  const { value, onChange } = props;
  return (
    <>
      <ProbeSwitch
        enabled={value.probe_enabled}
        disabled={props.disabled}
        onChange={(probe_enabled) => onChange({ ...value, probe_enabled })}
      />
      <BlockedProviders
        value={value.blocked_providers}
        disabled={props.disabled}
        onChange={(blocked_providers) => onChange({ ...value, blocked_providers })}
      />
    </>
  );
}
