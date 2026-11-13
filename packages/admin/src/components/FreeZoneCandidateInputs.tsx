import { InputNumber, Tooltip, Typography } from 'antd';
import type { AdminFreeZoneStatusModel, FreeZoneCandidate } from '@miniapp/shared';

/**
 * 线上状态里直接改每个模型的单独设置（折扣底线、并发数）；改的是表单里的候选池，
 * 和其他参数一起保存、发布后生效。
 */
export interface FreeZoneCandidateEditing {
  candidates: FreeZoneCandidate[];
  /** 初筛里的统一折扣底线：单独底线空着时用它，输入框里提示 */
  defaultDiscountPct: number;
  disabled?: boolean;
  onChange: (candidates: FreeZoneCandidate[]) => void;
}

export const PARALLEL_HINT =
  '每轮同时发几路请求（1–3）：先出字的胜出、其余取消；都没在「启动兜底等待」内出字就和兜底一起竞争。每多一路多一份 Surplus 费用。改完保存并发布配置后生效。';

export const DISCOUNT_HINT =
  '这个模型单独的折扣底线：空着用初筛里的统一底线，填了就按它（初筛、派单探测、真实请求都按它）。原价本来就低的模型可以放宽。改完保存并发布配置后生效。';

type Props = { model: AdminFreeZoneStatusModel; editing?: FreeZoneCandidateEditing };

/** 在表单候选池里找到这一行；已不在候选池的返回 null（没法设置）。 */
function locate(props: Props) {
  const { editing, model } = props;
  const index = editing?.candidates.findIndex((item) => item.id === model.candidate_id) ?? -1;
  const candidate = index >= 0 ? editing?.candidates[index] : undefined;
  if (!editing || !candidate) return null;
  const patch = (change: Partial<FreeZoneCandidate>) =>
    editing.onChange(
      editing.candidates.map((item, at) => (at === index ? { ...item, ...change } : item))
    );
  return { editing, candidate, patch };
}

function NotInPool() {
  return (
    <Tooltip title="已不在候选池，不能设置">
      <Typography.Text type="secondary">—</Typography.Text>
    </Tooltip>
  );
}

export function FreeZoneParallelInput(props: Props) {
  const found = locate(props);
  if (!found) return <NotInPool />;
  return (
    <InputNumber
      size="small"
      min={1}
      max={3}
      precision={0}
      style={{ width: 64 }}
      // 旧配置里没有这一项，按默认 1 显示
      value={found.candidate.parallel_requests ?? 1}
      disabled={found.editing.disabled}
      onChange={(value) => found.patch({ parallel_requests: value ?? 1 })}
    />
  );
}

export function FreeZoneDiscountInput(props: Props) {
  const found = locate(props);
  if (!found) return <NotInPool />;
  return (
    <InputNumber
      size="small"
      min={1}
      max={100}
      precision={0}
      style={{ width: 84 }}
      suffix="%"
      // 空着 = 用统一底线
      placeholder={`统一${found.editing.defaultDiscountPct}`}
      value={found.candidate.min_discount_pct ?? null}
      disabled={found.editing.disabled}
      onChange={(value) => found.patch({ min_discount_pct: value ?? null })}
    />
  );
}
