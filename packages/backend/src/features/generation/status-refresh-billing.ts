/**
 * 状态面板「立即更新」的计费：所有人每次 STATUS_REFRESH_CREDITS 星尘，专项优先（每 3 轮的自动更新不收费）。
 *
 * 先跑后扣：调模型前只查余额够不够；这次请求自己发起的更新真记下了新内容、接口要返回成功时才扣。
 * 不先扣后退：退款失败会让用户白丢星尘，钱包明细还会一扣一退；先跑后扣最坏只是平台少收一次。
 * 扣费从不抛错：扣不到（余额在更新期间被花掉、被聊天预留占住、RPC 出错）只记日志，更新结果照常返回。
 */
import { randomUUID } from 'node:crypto';
import { STATUS_REFRESH_CREDITS, type MemoryRefreshOutcome } from '@miniapp/shared';
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';
import { StatusRefreshChargeRepository } from '../../infrastructure/repositories/StatusRefreshChargeRepository.js';
import type { RequestLogger } from '../../platform/observability/logger.js';
import type { StatusUpdateOutcome } from '../status-bar/update.js';

let walletRepo: MiniappWalletRepository | null = null;
let chargeRepo: StatusRefreshChargeRepository | null = null;
const wallets = () => (walletRepo ??= new MiniappWalletRepository());
const charges = () => (chargeRepo ??= new StatusRefreshChargeRepository());

/** 调模型前的余额预检（通用 + 专项）。不看聊天预留：被预留占住时由扣费函数拦下，本次不收费。 */
export async function hasRefreshCredits(
  userId: string,
  sessionId: string,
  log: RequestLogger
): Promise<boolean> {
  const started = Date.now();
  const wallet = await wallets().findByUserId(userId);
  const available = wallet ? wallet.main_credits + wallet.bonus_credits : 0;
  if (available >= STATUS_REFRESH_CREDITS) return true;
  log.biz.info(
    {
      event: 'status_bar.refresh.insufficient',
      operation: 'status_bar.refresh.precheck',
      outcome: 'rejected',
      sessionId,
      requiredCount: STATUS_REFRESH_CREDITS,
      availableCount: Math.floor(available),
      durationMs: Date.now() - started,
    },
    '星尘不够立即更新，未调模型'
  );
  return false;
}

export interface RefreshParts {
  /** 状态更新结果；状态栏关着为 null */
  status: StatusUpdateOutcome | null;
  /** 发起前状态更新已在进行：这次只是等它（自动更新，免费）的结果 */
  statusJoined: boolean;
  memory: MemoryRefreshOutcome;
  memoryJoined: boolean;
}

export type RefreshBillReason = 'status_recorded' | 'memory_recorded' | 'joined' | 'nothing_new';

/** 只在接口要返回成功时调用：这次请求自己记下了新状态或新记忆才收费。 */
export function refreshBillable(parts: RefreshParts): {
  billable: boolean;
  reason: RefreshBillReason;
} {
  const statusNew = parts.status === 'ok' || parts.status === 'partial';
  const memoryNew = parts.memory === 'recorded';
  if (statusNew && !parts.statusJoined) return { billable: true, reason: 'status_recorded' };
  if (memoryNew && !parts.memoryJoined) return { billable: true, reason: 'memory_recorded' };
  return { billable: false, reason: statusNew || memoryNew ? 'joined' : 'nothing_new' };
}

/** 按这次的结果决定收不收费并记一笔日志；从不抛错。 */
export async function settleStatusRefresh(input: {
  userId: string;
  sessionId: string;
  parts: RefreshParts;
  log: RequestLogger;
}): Promise<void> {
  const started = Date.now();
  const { billable, reason } = refreshBillable(input.parts);
  const base = {
    event: 'status_bar.refresh.charge',
    operation: 'status_bar.refresh.charge',
    sessionId: input.sessionId,
    reason,
    creditCount: billable ? STATUS_REFRESH_CREDITS : 0,
  };
  if (!billable) {
    input.log.biz.info(
      { ...base, outcome: 'skipped', status: 'not_billable', durationMs: 0 },
      '立即更新没有新内容，不收费'
    );
    return;
  }
  try {
    const result = await charges().charge({
      chargeId: randomUUID(),
      userId: input.userId,
      sessionId: input.sessionId,
      amount: STATUS_REFRESH_CREDITS,
    });
    const fields = {
      ...base,
      status: result.status,
      mainCount: result.mainCredits,
      bonusCount: result.bonusCredits,
      durationMs: Date.now() - started,
    };
    if (result.status === 'insufficient')
      input.log.biz.warn({ ...fields, outcome: 'rejected' }, '立即更新扣费时余额不足，本次不收费');
    else input.log.biz.info({ ...fields, outcome: 'succeeded' }, '立即更新已扣费');
  } catch (err) {
    input.log.sys.error(
      { ...base, err, outcome: 'failed', status: 'failed', durationMs: Date.now() - started },
      '立即更新扣费出错，本次不收费'
    );
  }
}
