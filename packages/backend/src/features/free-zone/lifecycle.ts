/**
 * 畅聊候选模型的上下架（纯函数）。只有在架、未上架两种状态：
 * - 上架只由运营手动操作，固定一家供应商，之后不自动变；
 * - 下架由运营手动操作，或真实请求连续被 Surplus 拒单（报价跌破折扣底线、没有卖家，见 unroutable-guard.ts）；
 *   运营「保上」的模型不会被自动下架，手动下架同时取消保上；
 * - 下架后都由运营手动恢复，没有自动回架。
 * 首发出错一律由兜底接住，不因错误率、超时、中断下架。
 */
export type FreeZoneModelStatus = 'unlisted' | 'listed';

export interface FreeZoneModelState {
  candidateId: string;
  status: FreeZoneModelStatus;
  /** 在架时固定的供应商（恰好一家）；未上架为空 */
  providers: string[];
  providerSince: string | null;
  lastReason: string | null;
  /** 运营保上：不自动下架 */
  pinned: boolean;
}

export type FreeZoneEvent =
  | { type: 'listed'; providers: string[] }
  /** cause：official 连续拒单；null 运营手动下架 */
  | { type: 'delisted'; cause: 'official' | null; reasons: string[] };

type Transition = { state: FreeZoneModelState; event: FreeZoneEvent };

export const MANUAL_DELIST_REASON = '运营手动下架';

export function initialState(candidateId: string): FreeZoneModelState {
  return {
    candidateId,
    status: 'unlisted',
    providers: [],
    providerSince: null,
    lastReason: null,
    pinned: false,
  };
}

export function listManually(input: {
  state: FreeZoneModelState;
  provider: string;
  now: Date;
}): Transition {
  return {
    state: {
      ...input.state,
      status: 'listed',
      providers: [input.provider],
      providerSince: input.now.toISOString(),
      lastReason: null,
    },
    event: { type: 'listed', providers: [input.provider] },
  };
}

function delist(
  state: FreeZoneModelState,
  cause: 'official' | null,
  reasons: string[]
): Transition {
  return {
    state: {
      ...state,
      status: 'unlisted',
      providers: [],
      providerSince: null,
      lastReason: reasons.join('；'),
    },
    event: { type: 'delisted', cause, reasons },
  };
}

/** 真实请求连续被拒单：自动下架；保上的不动（返回 null） */
export function delistUnroutable(input: {
  state: FreeZoneModelState;
  reasons: string[];
}): Transition | null {
  if (input.state.pinned) return null;
  return delist(input.state, 'official', input.reasons);
}

/** 运营手动下架：同时取消保上 */
export function delistManually(input: { state: FreeZoneModelState }): Transition {
  const { state, event } = delist(input.state, null, [MANUAL_DELIST_REASON]);
  return { state: { ...state, pinned: false }, event };
}
