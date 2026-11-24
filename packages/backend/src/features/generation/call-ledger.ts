/**
 * 文本对话每次上游模型调用的台账（表：ops.llm_calls，见 20261119_db_reorg_p6a2c3_call_ledger_expand.sql）。
 *
 * 竞速里每一路调用（收费轮与畅聊、首发与兜底、胜出与落败/取消）结束时各写一行；成本由 call-costs 任务事后补。
 * 代表 attempt 的那一路沿用 attempt 那一行（id = attempt_id = attempt id，Surplus 预备记录与元数据补齐写的也是这一行），
 * 畅聊并发的其余各路另起一行（attempt_id 为空）。每轮总成本 = 该轮全部行的成本之和。
 * 写入只为核算花费：失败只记日志，绝不影响对话。
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import type { SettledCall } from './first-token-fallback.js';

export interface LlmCallRecord extends Omit<SettledCall, 'role' | 'endReason'> {
  /** rewrite：出字后中断或拒答，擦掉重写（见 stream-recovery.ts） */
  role: SettledCall['role'] | 'rewrite';
  /** refused：出字后兜底那一路开头又是拒答，被丢弃 */
  endReason: SettledCall['endReason'] | 'refused';
  chatHistoryId: string;
  lane: 'chat' | 'free_zone';
  /** 畅聊候选池里的候选 id；收费轮为空 */
  candidateId: string | null;
  /** 不代表 attempt 的调用可以指定行 id，以便之后补写 stream_end；缺省随机 */
  callId?: string;
}

function bounded(value: string | null, max: number): string | null {
  return value && value.length <= max ? value : null;
}

export async function insertLlmCall(call: LlmCallRecord): Promise<void> {
  const owns = await call.ownsAttempt();
  const id = owns ? call.attemptId : (call.callId ?? randomUUID());
  await prisma.$executeRaw`
    INSERT INTO ops.llm_calls AS l (
      id, attempt_id, chat_history_id, provider, model, generation_id, request_id, http_status,
      lane, role, slot, candidate_id, dispatched_at, end_reason)
    VALUES (
      ${id}::uuid, ${owns ? call.attemptId : null}::uuid, ${call.chatHistoryId}::uuid, ${call.provider},
      ${call.providerModelId}, ${bounded(call.generationId, 512)}, ${bounded(call.requestId, 512)},
      ${call.httpStatus}::integer, ${call.lane}, ${call.role}, ${call.slot}::smallint,
      ${bounded(call.candidateId, 64)}, ${call.dispatchedAt}::timestamptz, ${call.endReason})
    ON CONFLICT (id) DO UPDATE SET
      lane = EXCLUDED.lane,
      role = COALESCE(l.role, EXCLUDED.role),
      slot = COALESCE(l.slot, EXCLUDED.slot),
      candidate_id = COALESCE(l.candidate_id, EXCLUDED.candidate_id),
      dispatched_at = COALESCE(l.dispatched_at, EXCLUDED.dispatched_at),
      end_reason = COALESCE(l.end_reason, EXCLUDED.end_reason),
      model = COALESCE(l.model, EXCLUDED.model),
      generation_id = COALESCE(l.generation_id, EXCLUDED.generation_id),
      request_id = COALESCE(l.request_id, EXCLUDED.request_id),
      http_status = COALESCE(l.http_status, EXCLUDED.http_status),
      updated_at = now()`;
}

/** 竞速回调里调用：不等待、不抛错 */
export function recordLlmCall(
  call: LlmCallRecord,
  log: { warn(obj: object, msg: string): void }
): void {
  void insertLlmCall(call).catch((err: unknown) =>
    log.warn(
      {
        err: err instanceof Prisma.PrismaClientKnownRequestError ? err.code : err,
        event: 'llm.call_record_failed',
        historyId: call.chatHistoryId,
      },
      '模型调用台账写入失败'
    )
  );
}

/** 与迁移 20261124_llm_calls_stream_end.sql 的 llm_calls_stream_end_check 一致 */
export type StreamEnd =
  | 'completed'
  | 'stalled'
  | 'stream_error'
  | 'content_filter'
  | 'provider_error'
  | 'disconnected'
  | 'refused'
  | 'cancelled'
  | 'output_cap'
  | 'length';

const STREAM_END_RETRY_MS = 1_500;

/**
 * 被交付那一路出字后怎么结束的，写在它的台账行上（按平台 + 模型聚合中断率用）。
 * 首发/首字兜底的胜出行在出字时异步插入，极少数情况下比这里晚到：没更新到就等一下再试一次。
 * 只为统计：失败只记 warn。
 */
export function recordStreamEnd(
  target: { chatHistoryId: string } | { callId: string },
  end: StreamEnd,
  log: { warn(obj: object, msg: string): void }
): void {
  const update = () =>
    'callId' in target
      ? prisma.$executeRaw`
          UPDATE ops.llm_calls SET stream_end = ${end}, updated_at = now()
          WHERE id = ${target.callId}::uuid AND stream_end IS NULL`
      : prisma.$executeRaw`
          UPDATE ops.llm_calls SET stream_end = ${end}, updated_at = now()
          WHERE chat_history_id = ${target.chatHistoryId}::uuid
            AND end_reason = 'first_token_observed' AND stream_end IS NULL`;
  void (async () => {
    if ((await update()) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, STREAM_END_RETRY_MS));
    if ((await update()) === 0)
      log.warn(
        { event: 'llm.stream_end.unmatched', stream_end: end },
        '交付结束方式没有对应的调用行'
      );
  })().catch((err: unknown) =>
    log.warn(
      {
        err: err instanceof Prisma.PrismaClientKnownRequestError ? err.code : err,
        event: 'llm.stream_end.record_failed',
      },
      '交付结束方式写入失败'
    )
  );
}
