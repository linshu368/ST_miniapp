/**
 * 状态栏 / 记忆栏每次模型调用的台账（表 ops.llm_calls，lane = status_bar / memory_bar，见 20261126_panel_llm_calls.sql）。
 *
 * 首发、兜底、成功、失败、被丢弃的都记：成本看板要的是「花了多少」，不管结果有没有被采用。
 * 面板调用不属于任何聊天轮次（chat_history_id 为空），所以不会被经营核心算进聊天成本。
 * 成本由 call-costs 任务事后补：OpenRouter 按 generation id，Surplus（非 attempt 行）按请求号。
 * 写入只为核算花费：不等待、失败只记一笔观测事件，绝不影响状态更新。
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { StatusMemoryPanel } from '@miniapp/shared';
import { prisma } from '../../lib/db.js';
import { observation } from '../../platform/observability/runtime.js';

const WRITE_TIMEOUT_MS = 5_000;

export interface PanelCallFacts {
  provider: 'surplus' | 'openrouter';
  model: string;
  /** 请求真正发出去的时刻；没发出去（配置读不到、没配密钥）为 null，不记账 */
  dispatchedAt: Date | null;
  httpStatus: number | null;
  /** Surplus 请求号（查买家成本用） */
  requestId: string | null;
  /** OpenRouter generation id（查实际花费用）；Surplus 流里有就顺带记 */
  generationId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface PanelLlmCall extends PanelCallFacts {
  panel: StatusMemoryPanel;
  role: 'primary' | 'fallback';
  trigger: 'auto' | 'manual';
  /** completed，或 StatusModelError 的错误码（first_token_timeout、http_429、truncated…） */
  endReason: string;
}

const bounded = (value: string | null, max: number) =>
  value && value.length <= max ? value : null;
const tokens = (value: number | null) =>
  value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
const status = (value: number | null) =>
  value !== null && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;

async function insertPanelLlmCall(call: PanelLlmCall): Promise<void> {
  if (!call.dispatchedAt) return;
  await prisma.$executeRaw`
    INSERT INTO ops.llm_calls (
      id, chat_history_id, provider, model, generation_id, request_id, http_status,
      prompt_tokens, completion_tokens, lane, role, panel_trigger, dispatched_at, end_reason)
    VALUES (
      ${randomUUID()}::uuid, NULL, ${call.provider}, ${bounded(call.model, 256)},
      ${bounded(call.generationId, 512)}, ${bounded(call.requestId, 512)}, ${status(call.httpStatus)}::integer,
      ${tokens(call.promptTokens)}::bigint, ${tokens(call.completionTokens)}::bigint,
      ${call.panel === 'memory' ? 'memory_bar' : 'status_bar'}, ${call.role}, ${call.trigger},
      ${call.dispatchedAt}::timestamptz, ${call.endReason.slice(0, 32) || 'unknown'})`;
}

/** 调用结束时调：不等待、不抛错。 */
export function recordPanelLlmCall(call: PanelLlmCall): void {
  if (!call.dispatchedAt) return;
  const started = Date.now();
  void Promise.race([
    insertPanelLlmCall(call),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('panel_llm_call_write_timeout')), WRITE_TIMEOUT_MS).unref()
    ),
  ]).catch((err: unknown) =>
    observation.emit(
      'panel_llm_call.record_failed',
      'panel_llm_call.record',
      {
        outcome: 'failed',
        outcome_known: true,
        provider: call.provider,
        stage: call.role,
        error_code: err instanceof Prisma.PrismaClientKnownRequestError ? err.code : 'write_failed',
        duration_ms: Date.now() - started,
      },
      'warn'
    )
  );
}
