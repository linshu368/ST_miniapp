import {
  createWalletBalanceSplit,
  type GetWalletBalanceData,
  type WalletSpendingRecord,
} from '@miniapp/shared';
import type { NumericValue, MiniappWalletRow, RawMiniappWalletRow } from './wallet-model.js';

export function toWalletBalance(row: MiniappWalletRow): GetWalletBalanceData {
  const mainCredits = toNumber(row.main_credits);
  const bonusCredits = toNumber(row.bonus_credits);
  const split = createWalletBalanceSplit(mainCredits, bonusCredits);
  if (!split.ok) {
    throw new Error('钱包余额拆分无效');
  }
  if (row.total_credits !== null && toNumber(row.total_credits) !== split.value.total_credits) {
    throw new Error('钱包余额不守恒');
  }
  return {
    credits: split.value.total_credits,
    main_credits: split.value.main_credits,
    bonus_credits: split.value.bonus_credits,
    total_credits: split.value.total_credits,
    first_paid_at: row.first_paid_at,
    last_paid_at: row.last_paid_at,
    total_paid_amount: String(row.total_paid_amount ?? '0.00'),
  };
}

/**
 * 转换为领取签到奖励结果
 * @param raw 签到 RPC 数据
 * @returns 领取签到奖励结果
 */

/**
 * 转换为 MiniApp 钱包行
 * @param row 原始 MiniApp 钱包行
 * @returns MiniApp 钱包行
 */
export function normalizeWallet(row: RawMiniappWalletRow): MiniappWalletRow {
  return {
    ...row,
    main_credits: toNumber(row.main_credits),
    bonus_credits: toNumber(row.bonus_credits),
    total_credits: row.total_credits === null ? null : toNumber(row.total_credits),
  };
}

/**
 * 转换为数字
 * @param value 数值值
 * @returns 数字
 */
export function toNumber(value: NumericValue): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`无效的数值字段：${String(value)}`);
  return parsed;
}

export function mapLlmSpendingRow(row: {
  charge_key: string;
  model_id: string | null;
  model_display_name: string;
  charged_amount: NumericValue;
  status: WalletSpendingRecord['status'];
  metadata: Record<string, unknown> | null;
  created_at: string;
}): WalletSpendingRecord {
  const metadata = row.metadata ?? {};
  const record: WalletSpendingRecord = {
    id: row.charge_key,
    model_id: row.model_id,
    model_display_name: row.model_display_name,
    charged_amount: toNumber(row.charged_amount),
    status: row.status,
    finish_reason: typeof metadata.finish_reason === 'string' ? metadata.finish_reason : null,
    reply_outcome: readReplyOutcome(metadata),
    status_label: formatSpendingStatus(row.status, metadata),
    created_at: row.created_at,
  };
  const mainDelta = readOptionalNumber(metadata.main_delta);
  const bonusDelta = readOptionalNumber(metadata.bonus_delta);
  const originalAmount = readOptionalNullableNumber(metadata, 'original_credits');
  const discountRate = readOptionalNullableNumber(metadata, 'discount_rate');
  if (mainDelta !== undefined) record.main_delta = mainDelta;
  if (bonusDelta !== undefined) record.bonus_delta = bonusDelta;
  if (originalAmount !== undefined) record.original_amount = originalAmount;
  if (discountRate !== undefined) record.discount_rate = discountRate;
  return record;
}

export function mapLlmRefundSpendingRow(row: {
  reference_id: string | null;
  amount: NumericValue;
  main_delta: NumericValue;
  bonus_delta: NumericValue;
  metadata: Record<string, unknown> | null;
  created_at: string;
}): WalletSpendingRecord {
  const metadata = row.metadata ?? {};
  const refundOf = typeof metadata.debit_key === 'string' ? metadata.debit_key : null;
  return {
    id: row.reference_id ?? row.created_at,
    model_id: null,
    model_display_name: '文本消费退款',
    charged_amount: Math.abs(toNumber(row.amount)),
    status: 'charged',
    finish_reason: null,
    reply_outcome: null,
    status_label: '已原路退回',
    created_at: row.created_at,
    main_delta: toNumber(row.main_delta),
    bonus_delta: toNumber(row.bonus_delta),
    ...(refundOf ? { refund_of: refundOf } : {}),
    source_label: '原路退款',
  };
}

export function formatSpendingStatus(
  status: WalletSpendingRecord['status'],
  metadata: Record<string, unknown>
): string {
  const replyOutcome = readReplyOutcome(metadata);

  if (status === 'pending') return '待结算';
  if (status === 'charged' || status === 'reconciled') return '已扣费';
  if (status === 'partial') return '余额不足，部分扣费';
  if (status === 'free') return '本次免费';
  if (replyOutcome === 'incomplete') return '截断未扣除';
  if (replyOutcome === 'empty') return '生成失败，未扣除';
  const finishReason = typeof metadata.finish_reason === 'string' ? metadata.finish_reason : null;
  const generationStatus =
    typeof metadata.generation_status === 'string'
      ? metadata.generation_status
      : typeof metadata.chat_status === 'string'
        ? metadata.chat_status
        : null;
  if (finishReason && finishReason !== 'stop') return '截断未扣除';
  if (generationStatus === 'stream_interrupted') return '截断未扣除';
  if (generationStatus === 'upstream_error') return '生成失败，未扣除';
  return '未扣除';
}

/**
 * 读取回复结果
 * @param metadata 元数据
 * @returns 回复结果
 */
export function readReplyOutcome(
  metadata: Record<string, unknown>
): WalletSpendingRecord['reply_outcome'] {
  const value = metadata.reply_outcome;
  return value === 'complete' || value === 'incomplete' || value === 'empty' ? value : null;
}

export function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function readOptionalNullableNumber(
  metadata: Record<string, unknown>,
  key: string
): number | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(metadata, key)) return undefined;
  const value = metadata[key];
  if (value === null) return null;
  return readOptionalNumber(value);
}
