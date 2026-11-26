import type { WalletSpendingRecord } from '@miniapp/shared';
import type { getDomainDb } from '../../lib/supabase.js';
import type { NumericValue } from './wallet-model.js';
import { toNumber } from './wallet-mapping.js';

type LedgerRow = {
  id: string;
  reference_id: string | null;
  reference_type: string;
  amount: NumericValue;
  main_delta?: NumericValue | null;
  bonus_delta?: NumericValue | null;
  created_at: string;
};

/** Keep existing per-media history limits; video traffic must not hide voice or image rows. */
/** 状态面板「立即更新」按次扣费也走这里（专项优先，带通用/专项拆分）。 */
export async function listMediaSpending(
  db: ReturnType<typeof getDomainDb>,
  userId: string
): Promise<WalletSpendingRecord[]> {
  const segments = await Promise.all([
    readLedger(db, userId, ['voice_usage']),
    readLedger(db, userId, ['image_generation', 'image_plaza_generation']),
    readLedger(db, userId, ['media_plaza_video_reserve', 'media_plaza_video_refund']),
    readLedger(db, userId, ['status_refresh']),
  ]);
  return segments.flat().map(mapMediaSpending);
}

async function readLedger(
  db: ReturnType<typeof getDomainDb>,
  userId: string,
  referenceTypes: string[]
): Promise<LedgerRow[]> {
  const { data, error } = await db
    .from('wallet_ledger')
    .select('id,reference_type,reference_id,amount,main_delta,bonus_delta,created_at')
    .eq('user_id', userId)
    .in('reference_type', referenceTypes)
    .order('created_at', { ascending: false })
    .abortSignal(AbortSignal.timeout(5_000))
    .limit(100);
  if (error) throw new Error('查询媒体消费明细失败', { cause: error });
  return (data ?? []) as LedgerRow[];
}

function mapMediaSpending(row: LedgerRow): WalletSpendingRecord {
  if (row.reference_type === 'status_refresh') return mapStatusRefresh(row);
  const video = row.reference_type.startsWith('media_plaza_video_');
  const refund = row.reference_type === 'media_plaza_video_refund';
  const reference = row.reference_id ?? row.id;
  const record: WalletSpendingRecord = {
    // Reserve and refund share an attempt reference; give each its own stable React key.
    id: video
      ? `${refund ? 'video-refund' : 'video'}:${reference}`
      : (row.reference_id ?? row.created_at),
    model_id: null,
    model_display_name: video
      ? refund
        ? '视频退款'
        : '视频消费'
      : row.reference_type === 'voice_usage'
        ? '语音消费'
        : '图片消费',
    charged_amount: Math.abs(toNumber(row.amount)),
    status: 'charged',
    finish_reason: null,
    reply_outcome: null,
    status_label: refund ? '已原路退回' : video ? '已预扣' : '已扣费',
    created_at: row.created_at,
  };
  if (video) {
    if (row.main_delta != null) record.main_delta = toNumber(row.main_delta);
    if (row.bonus_delta != null) record.bonus_delta = toNumber(row.bonus_delta);
    record.source_label = refund ? '原路退款' : '视频预扣';
    if (refund && row.reference_id) record.refund_of = `video:${row.reference_id}`;
  }
  return record;
}

function mapStatusRefresh(row: LedgerRow): WalletSpendingRecord {
  const record: WalletSpendingRecord = {
    id: `status-refresh:${row.reference_id ?? row.id}`,
    model_id: null,
    model_display_name: '状态更新',
    charged_amount: Math.abs(toNumber(row.amount)),
    status: 'charged',
    finish_reason: null,
    reply_outcome: null,
    status_label: '已扣费',
    created_at: row.created_at,
  };
  if (row.main_delta != null) record.main_delta = toNumber(row.main_delta);
  if (row.bonus_delta != null) record.bonus_delta = toNumber(row.bonus_delta);
  return record;
}
