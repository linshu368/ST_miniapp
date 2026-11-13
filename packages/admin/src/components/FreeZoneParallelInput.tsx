import { InputNumber, Tooltip, Typography } from 'antd';
import type { AdminFreeZoneStatusModel, FreeZoneCandidate } from '@miniapp/shared';

/** 线上状态「在架」里直接改每个模型的并发数；改的是表单里的候选池，和其他参数一起保存、发布。 */
export interface FreeZoneParallelEditing {
  candidates: FreeZoneCandidate[];
  disabled?: boolean;
  onChange: (candidates: FreeZoneCandidate[]) => void;
}

export const PARALLEL_HINT =
  '每轮同时发几路请求（1–3）：先出字的胜出、其余取消；都没在「启动兜底等待」内出字就和兜底一起竞争。每多一路多一份 Surplus 费用。改完保存并发布配置后生效。';

export function FreeZoneParallelInput(props: {
  model: AdminFreeZoneStatusModel;
  editing?: FreeZoneParallelEditing;
}) {
  const { editing, model } = props;
  const index = editing?.candidates.findIndex((item) => item.id === model.candidate_id) ?? -1;
  const candidate = index >= 0 ? editing?.candidates[index] : undefined;
  if (!editing || !candidate) {
    return (
      <Tooltip title="已不在候选池，不能设置">
        <Typography.Text type="secondary">—</Typography.Text>
      </Tooltip>
    );
  }
  return (
    <InputNumber
      size="small"
      min={1}
      max={3}
      precision={0}
      style={{ width: 64 }}
      // 旧配置里没有这一项，按默认 1 显示
      value={candidate.parallel_requests ?? 1}
      disabled={editing.disabled}
      onChange={(value) =>
        editing.onChange(
          editing.candidates.map((item, at) =>
            at === index ? { ...item, parallel_requests: value ?? 1 } : item
          )
        )
      }
    />
  );
}
