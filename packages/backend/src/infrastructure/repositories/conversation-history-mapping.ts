import { readPostprocessVersion, type ChatMessage, type ChatMessageStatus } from '@miniapp/shared';
import type { InstructionSlotModes } from '../../features/engine/types.js';
import type { GenerationMessage } from '../../features/generation/types.js';
import { turnsToMessages } from '../../features/conversations/history.js';
import type {
  ConversationContext,
  ConversationHistoryRow,
  StartedHistoryTurn,
} from './conversation-history-types.js';

export interface StartedHistoryTurnRpc {
  turn_index?: number;
  history_id?: string;
  revision?: number;
  context_window_start_turn?: number;
  postprocess_version?: number | null;
  choice_rules_mode?: unknown;
}

export function mapStartedTurn(
  result: StartedHistoryTurnRpc | null,
  userContent: string
): StartedHistoryTurn {
  const postprocessVersion = readPostprocessVersion(result?.postprocess_version);
  const slotModes = readInstructionSlotModes(result);
  if (
    typeof result?.turn_index !== 'number' ||
    !result.history_id ||
    typeof result.revision !== 'number' ||
    postprocessVersion === null ||
    slotModes === null
  ) {
    throw new Error('创建对话轮次结果字段不完整');
  }
  return {
    turnIndex: result.turn_index,
    historyId: result.history_id,
    revision: result.revision,
    userContent,
    contextWindowStartTurn: readWindowStart(result.context_window_start_turn),
    postprocessVersion,
    slotModes,
  };
}

function readInstructionSlotModes(
  result: StartedHistoryTurnRpc | null
): InstructionSlotModes | null {
  // 正文模型只剩选项一个槽位（状态栏、记忆栏都由独立模型记录、右侧面板展示）。
  const choice = result?.choice_rules_mode;
  return choice === 'full' || choice === 'concise' || choice === 'off' ? { choice } : null;
}

export function readWindowStart(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

export function assembleConversationContext(input: {
  windowStartTurn: number;
  windowRows: ConversationHistoryRow[];
  openingMessage?: string | null;
}): ConversationContext {
  const turns = input.windowRows.map((row) => ({
    turnIndex: row.turn_index,
    userInput: row.user_input,
    assistantReply: row.assistant_reply,
    status: row.status,
  }));
  return {
    // The opening lives in turn 1's display projection (written at admission, backfilled for older turns).
    openingMessage:
      input.openingMessage !== undefined
        ? input.openingMessage
        : (input.windowRows[0]?.display_opening_message ?? null),
    messages: turnsToMessages(turns),
    turns,
    truncatedTurns: Math.max(input.windowStartTurn - 1, 0),
  };
}

export function latestRevisionRows(rows: ConversationHistoryRow[]): ConversationHistoryRow[] {
  const latest = new Map<number, ConversationHistoryRow>();
  for (const row of rows) {
    const existing = latest.get(row.turn_index);
    if (!existing || row.revision > existing.revision) latest.set(row.turn_index, row);
  }
  return [...latest.values()].sort((left, right) => left.turn_index - right.turn_index);
}

export function toChatMessages(row: ConversationHistoryRow): ChatMessage[] {
  const requestId = row.display_request_id;
  return [
    {
      id: `${row.id}:user`,
      ...(row.user_edit_version ? { edit_version: row.user_edit_version } : {}),
      ...(row.user_deleted ? { deleted: true } : {}),
      ...(row.is_inherited ? { inherited: true } : {}),
      session_id: row.session_id,
      turn_index: row.turn_index,
      role: 'user',
      revision: row.revision,
      content: row.user_deleted ? '' : row.user_input,
      status: 'complete',
      error_code: null,
      finish_reason: null,
      model_id: null,
      postprocess_version: null,
      created_at: row.created_at,
    },
    {
      id: row.id,
      ...(row.assistant_edit_version ? { edit_version: row.assistant_edit_version } : {}),
      ...(row.assistant_deleted ? { deleted: true } : {}),
      ...(row.is_inherited ? { inherited: true } : {}),
      ...(typeof row.liked === 'boolean' ? { liked: row.liked } : {}),
      ...(!row.is_inherited && requestId ? { request_id: requestId } : {}),
      session_id: row.session_id,
      turn_index: row.turn_index,
      role: 'assistant',
      revision: row.revision,
      content: row.assistant_deleted
        ? ''
        : (row.assistant_reply ??
          (row.first_token_preview?.kind === 'delta' ? row.first_token_preview.text : '')),
      ...(row.status === 'streaming' && row.first_token_preview?.kind === 'reasoning'
        ? { reasoning: row.first_token_preview.text }
        : {}),
      status: toChatMessageStatus(row.status),
      error_code: toErrorCode(row.status),
      finish_reason: row.llm_finish_reason,
      model_id: row.model,
      ...creditsPerTurn(row.deduction_rate),
      postprocess_version: readPostprocessVersion(row.postprocess_version),
      created_at: row.created_at,
    },
  ];
}

export function toOpeningMessage(sessionId: string, content: string, createdAt = ''): ChatMessage {
  return {
    id: `opening:${sessionId}`,
    session_id: sessionId,
    turn_index: 0,
    role: 'assistant',
    revision: 0,
    content,
    status: 'complete',
    error_code: null,
    finish_reason: null,
    model_id: null,
    postprocess_version: null,
    created_at: createdAt,
  };
}

export function toChatMessageStatus(status: string): ChatMessageStatus {
  if (status === 'streaming') return 'streaming';
  if (status === 'success') return 'complete';
  if (status === 'stream_interrupted') return 'interrupted';
  return 'failed';
}

function toErrorCode(status: string): string | null {
  return ['streaming', 'success', 'stream_interrupted'].includes(status) ? null : status;
}

export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

export function withStoredRequestId(
  history: GenerationMessage[],
  requestId?: string
): Array<GenerationMessage & { request_id?: string }> {
  if (!requestId) return history;
  const first = history[0] ?? { role: 'system', content: '' };
  return [{ ...first, request_id: requestId }, ...history.slice(1)];
}

/** deduction_rate 是开轮时定下的每轮星尘；继承的历史在视图里是 NULL，不下发 */
function creditsPerTurn(rate: number | string | null | undefined): { credits_per_turn?: number } {
  if (rate === null || rate === undefined) return {};
  const value = Number(rate);
  return Number.isFinite(value) && value >= 0 ? { credits_per_turn: value } : {};
}
