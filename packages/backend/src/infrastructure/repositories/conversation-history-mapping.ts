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
  status_rules_mode?: unknown;
  memory_rules_mode?: unknown;
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
  const values = [result?.choice_rules_mode, result?.status_rules_mode, result?.memory_rules_mode];
  if (!values.every((value) => value === 'full' || value === 'concise' || value === 'off')) {
    return null;
  }
  return { choice: values[0], status: values[1], memory: values[2] } as InstructionSlotModes;
}

export function readWindowStart(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

export function assembleConversationContext(input: {
  windowStartTurn: number;
  windowRows: ConversationHistoryRow[];
  openingHistory?: unknown[];
  openingMessage?: string | null;
}): ConversationContext {
  const openingSource = input.openingHistory ?? input.windowRows[0]?.history;
  const turns = input.windowRows.map((row) => ({
    turnIndex: row.turn_index,
    userInput: row.user_input,
    assistantReply: row.assistant_reply,
  }));
  return {
    openingMessage:
      input.openingMessage !== undefined
        ? input.openingMessage
        : input.windowRows[0]?.display_opening_message !== undefined
          ? input.windowRows[0].display_opening_message
          : extractOpeningMessage(openingSource),
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

export function extractOpeningMessage(history: unknown[] | undefined): string | null {
  if (!Array.isArray(history)) return null;
  for (const item of history) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as { role?: unknown; content?: unknown };
    if (candidate.role === 'assistant' && typeof candidate.content === 'string') {
      const content = candidate.content.trim();
      if (content) return content;
    }
  }
  return null;
}

export function toChatMessages(row: ConversationHistoryRow): ChatMessage[] {
  const requestId =
    row.display_request_id !== undefined ? row.display_request_id : extractRequestId(row.history);
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

function extractRequestId(history: unknown[] | undefined): string | undefined {
  const first = history?.[0];
  if (!first || typeof first !== 'object') return undefined;
  const requestId = (first as { request_id?: unknown }).request_id;
  return typeof requestId === 'string' ? requestId : undefined;
}
