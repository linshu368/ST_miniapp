// 自研对话的唯一事实来源：miniapp.chat_history。
//
// 一行代表 session 内一个 turn 的一个 revision；同轮 revision 最大者是当前版本。
// ST 链路写入的行没有 session_id / turn_index / revision，本仓库不会读到它们。

import type { ChatMessage, ChatMessageStatus } from '@miniapp/shared';
import type { GenerationMessage, GenerationStatus } from '../../features/generation/types.js';
import { getSupabaseClient } from '../../lib/supabase.js';
import { throwConversationRpcError } from './conversation-errors.js';

export const STREAMING_STALE_SECONDS = 120;

export interface ConversationHistoryRow {
  id: string;
  user_id: string;
  model: string;
  user_input: string;
  assistant_reply: string | null;
  history: unknown[];
  character_id: string | null;
  preset_id: string | null;
  status: string;
  upstream_status: number | null;
  deduction_rate: number | null;
  created_at: string;
  llm_finish_reason: string | null;
  llm_generation_id: string | null;
  llm_charge_id: string | null;
  session_id: string;
  turn_index: number;
  revision: number;
}

export interface StartedHistoryTurn {
  turnIndex: number;
  historyId: string;
  revision: number;
  userContent: string;
}

export interface ConversationContext {
  /** 首轮实际 prompt 中保存的开场白；尚无历史时为 null，由调用方使用角色卡当前 first_mes */
  openingMessage: string | null;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export class ConversationHistoryRepository {
  private readonly db = getSupabaseClient().schema('miniapp');

  async startTurn(input: {
    sessionId: string;
    userContent: string;
    model: string;
    staleAfterSeconds?: number;
  }): Promise<StartedHistoryTurn> {
    const { data, error } = await this.db.rpc('start_chat_history_turn', {
      p_session_id: input.sessionId,
      p_user_content: input.userContent,
      p_model: input.model,
      p_stale_after_seconds: input.staleAfterSeconds ?? STREAMING_STALE_SECONDS,
    });
    if (error) throwConversationRpcError(error, '创建对话轮次失败');

    const result = data as {
      turn_index?: number;
      history_id?: string;
      revision?: number;
    } | null;
    if (
      typeof result?.turn_index !== 'number' ||
      !result.history_id ||
      typeof result.revision !== 'number'
    ) {
      throw new Error('创建对话轮次结果字段不完整');
    }
    return {
      turnIndex: result.turn_index,
      historyId: result.history_id,
      revision: result.revision,
      userContent: input.userContent,
    };
  }

  async startRegeneration(input: {
    sessionId: string;
    turnIndex?: number;
    model: string;
    staleAfterSeconds?: number;
  }): Promise<StartedHistoryTurn> {
    const { data, error } = await this.db.rpc('start_chat_history_regeneration', {
      p_session_id: input.sessionId,
      p_turn_index: input.turnIndex ?? null,
      p_model: input.model,
      p_stale_after_seconds: input.staleAfterSeconds ?? STREAMING_STALE_SECONDS,
    });
    if (error) throwConversationRpcError(error, '发起重生成失败');

    const result = data as {
      turn_index?: number;
      history_id?: string;
      revision?: number;
      user_content?: string;
    } | null;
    if (
      typeof result?.turn_index !== 'number' ||
      !result.history_id ||
      typeof result.revision !== 'number' ||
      typeof result.user_content !== 'string'
    ) {
      throw new Error('发起重生成结果字段不完整');
    }
    return {
      turnIndex: result.turn_index,
      historyId: result.history_id,
      revision: result.revision,
      userContent: result.user_content,
    };
  }

  async setPromptHistory(historyId: string, history: GenerationMessage[]): Promise<void> {
    const { error } = await this.db.from('chat_history').update({ history }).eq('id', historyId);
    if (error) throw new Error(`写入对话上下文快照失败：${error.message}`);
  }

  async finalizeTurn(input: {
    historyId: string;
    content: string;
    status: GenerationStatus;
    finishReason?: string | null;
    upstreamStatus?: number | null;
    generationId?: string | null;
    chargeId?: string | null;
  }): Promise<ConversationHistoryRow> {
    const { data, error } = await this.db
      .from('chat_history')
      .update({
        assistant_reply: input.content || null,
        status: input.status,
        upstream_status: input.upstreamStatus ?? null,
        llm_finish_reason: input.finishReason ?? null,
        llm_generation_id: input.generationId ?? null,
        llm_charge_id: input.chargeId ?? null,
      })
      .eq('id', input.historyId)
      .select('*')
      .single();
    if (error) throw new Error(`收口对话轮次失败：${error.message}`);
    return data as ConversationHistoryRow;
  }

  /**
   * 返回 current turn 之前的当前版本上下文。每轮取最大 revision，旧版本只用于审计。
   * 开场白从首轮保存的完整 prompt 快照提取，不另建数据库行。
   */
  async getContextBeforeTurn(sessionId: string, turnIndex: number): Promise<ConversationContext> {
    const { data, error } = await this.db
      .from('current_chat_history')
      .select('*')
      .eq('session_id', sessionId)
      .lt('turn_index', turnIndex)
      .order('turn_index', { ascending: true });
    if (error) throw new Error(`读取会话上下文失败：${error.message}`);

    const currentRows = (data ?? []) as ConversationHistoryRow[];
    return {
      openingMessage: extractOpeningMessage(currentRows[0]?.history),
      messages: currentRows.flatMap((row) => {
        const messages: ConversationContext['messages'] = [
          { role: 'user', content: row.user_input },
        ];
        if (row.assistant_reply?.trim()) {
          messages.push({ role: 'assistant', content: row.assistant_reply });
        }
        return messages;
      }),
    };
  }

  async listMessages(
    sessionId: string,
    openingMessage: string,
    options: { limit?: number; beforeTurnIndex?: number } = {}
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const limit = clampLimit(options.limit, 50, 200);
    const turnLimit = Math.max(Math.ceil(limit / 2), 1);

    let query = this.db
      .from('current_chat_history')
      .select('*')
      .eq('session_id', sessionId)
      .not('turn_index', 'is', null);
    if (typeof options.beforeTurnIndex === 'number') {
      query = query.lt('turn_index', options.beforeTurnIndex);
    }

    const { data, error } = await query
      .order('turn_index', { ascending: false })
      .limit(turnLimit + 1);
    if (error) throw new Error(`查询会话消息失败：${error.message}`);

    const latest = (data ?? []) as ConversationHistoryRow[];
    const hasMore = latest.length > turnLimit;
    const page = latest.slice(0, turnLimit).reverse();
    const persistedOpening = extractOpeningMessage(
      latest.slice().sort((left, right) => left.turn_index - right.turn_index)[0]?.history
    );
    // 长会话向前翻到最后一页时才补开场白；第一页不足一页时同样会命中。
    const includeOpening = !hasMore;
    const messages = page.flatMap(toChatMessages);
    if (includeOpening && (persistedOpening ?? openingMessage).trim()) {
      messages.unshift(toOpeningMessage(sessionId, persistedOpening ?? openingMessage));
    }
    return { messages, hasMore };
  }
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
  return [
    {
      id: `${row.id}:user`,
      session_id: row.session_id,
      turn_index: row.turn_index,
      role: 'user',
      revision: row.revision,
      content: row.user_input,
      status: 'complete',
      error_code: null,
      finish_reason: null,
      model_id: null,
      created_at: row.created_at,
    },
    {
      id: row.id,
      session_id: row.session_id,
      turn_index: row.turn_index,
      role: 'assistant',
      revision: row.revision,
      content: row.assistant_reply ?? '',
      status: toChatMessageStatus(row.status),
      error_code: toErrorCode(row.status),
      finish_reason: row.llm_finish_reason,
      model_id: row.model,
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
