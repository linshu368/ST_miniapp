/**
 * 畅聊每次上游调用的记录（表：miniapp_features.free_zone_calls，见 20261116_free_zone_calls.sql）。
 *
 * 竞速里每一路主请求、兜底结束时各写一行，花费留空，由 call-costs 任务事后按账单补上。
 * 写入只为核算花费：失败只记日志，绝不影响对话。
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import type { SettledCall } from '../generation/first-token-fallback.js';

export interface FreeZoneCallRecord extends SettledCall {
  chatHistoryId: string;
  candidateId: string;
}

function bounded(value: string | null, max: number): string | null {
  return value && value.length <= max ? value : null;
}

export async function insertFreeZoneCall(call: FreeZoneCallRecord): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO miniapp_features.free_zone_calls (
      id, chat_history_id, candidate_id, role, slot, provider, provider_model,
      dispatched_at, end_reason, request_id, generation_id)
    VALUES (
      ${randomUUID()}::uuid, ${call.chatHistoryId}::uuid, ${call.candidateId}, ${call.role},
      ${call.slot}::smallint, ${call.provider}, ${call.providerModelId},
      ${call.dispatchedAt}::timestamptz, ${call.endReason},
      ${bounded(call.requestId, 512)}, ${bounded(call.generationId, 512)})
    ON CONFLICT (chat_history_id, role, slot) DO NOTHING`;
}

/** 竞速回调里调用：不等待、不抛错 */
export function recordFreeZoneCall(
  call: FreeZoneCallRecord,
  log: { warn(obj: object, msg: string): void }
): void {
  void insertFreeZoneCall(call).catch((err: unknown) =>
    log.warn(
      {
        err: err instanceof Prisma.PrismaClientKnownRequestError ? err.code : err,
        event: 'free_zone.call_record_failed',
        historyId: call.chatHistoryId,
      },
      '畅聊上游调用记录写入失败'
    )
  );
}
