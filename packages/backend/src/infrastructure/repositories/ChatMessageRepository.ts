// 自研引擎对话消息仓库（M1）。
//
// 方案：docs/ST_remove-MVP实施方案.md §5.4 / §5.5 / §5.6。
// 表结构见 migration 069，两个需要原子性的写入走 migration 070 的 RPC。
//
// 三条纪律：
//   1. 展示与上下文一律只看 is_active 行，重生成的旧版本只留档
//   2. getContextMessages 返回有序全量，不截断、也不切掉尾部本轮 user 消息
//      （MVP 无上下文长度管理；切片归 M3b，因为 EngineInput 把本轮输入拆成了 userInput）
//   3. 一轮问答共用一个 turn_index，assistant 的 revision 从 0 递增

import type { ChatMessage, ChatMessageStatus, UserGenerationConfig } from '@miniapp/shared';
import { getSupabaseClient } from '../../lib/supabase.js';
import { throwConversationRpcError } from './conversation-errors.js';

/** §5.6：超过这个时长没有更新的 streaming 行视为断流，先标 interrupted 再放行新请求 */
export const STREAMING_STALE_SECONDS = 120;

export interface ChatMessageRow {
  id: string;
  session_id: string;
  turn_index: number;
  role: 'user' | 'assistant';
  revision: number;
  is_active: boolean;
  content: string;
  status: ChatMessageStatus;
  error_code: string | null;
  finish_reason: string | null;
  model_id: string | null;
  model_openrouter_id: string | null;
  preset_id: string | null;
  gen_config: UserGenerationConfig | null;
  charge_id: string | null;
  generation_id: string | null;
  created_at: string;
  updated_at: string;
}

/** 生成配置快照（总方案决策 10）：仅 assistant 行填充 */
export interface GenerationSnapshot {
  modelId: string | null;
  modelOpenrouterId: string | null;
  presetId: string | null;
  genConfig: UserGenerationConfig | null;
}

/** 引擎上下文用的最小形状。EngineInput 的转换归 M3b，仓库层不依赖引擎类型。 */
export interface ChatContextMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AppendUserTurnResult {
  turnIndex: number;
  userMessageId: string;
}

export interface StartRegenerationResult {
  turnIndex: number;
  assistantMessageId: string;
  revision: number;
  /** 该轮已存在的用户输入，重生成时作为 EngineInput.userInput 复用 */
  userContent: string;
}

export interface FinalizeAssistantMessageInput {
  messageId: string;
  content: string;
  status: Exclude<ChatMessageStatus, 'streaming'>;
  finishReason?: string | null;
  errorCode?: string | null;
  generationId?: string | null;
  chargeId?: string | null;
}

export class ChatMessageRepository {
  private readonly db = getSupabaseClient().schema('miniapp');

  /** 建会话时播种开场白：turn 0 的普通 assistant 消息，无专用标记字段（本轮决策 3） */
  async insertOpeningMessage(sessionId: string, content: string): Promise<ChatMessageRow> {
    const { data, error } = await this.db
      .from('chat_messages')
      .insert({
        session_id: sessionId,
        turn_index: 0,
        role: 'assistant',
        content,
        status: 'complete',
      })
      .select('*')
      .single();

    if (error) throw new Error(`写入开场白失败：${error.message}`);
    return data as ChatMessageRow;
  }

  /** 发消息：算 turn_index + 落 user 行，单事务（RPC）。会话忙时抛 session_busy。 */
  async appendUserTurn(
    sessionId: string,
    content: string,
    staleAfterSeconds = STREAMING_STALE_SECONDS
  ): Promise<AppendUserTurnResult> {
    const { data, error } = await this.db.rpc('append_chat_turn', {
      p_session_id: sessionId,
      p_user_content: content,
      p_stale_after_seconds: staleAfterSeconds,
    });

    if (error) throwConversationRpcError(error, '追加对话轮次失败');

    const result = data as { turn_index?: number; user_message_id?: string } | null;
    if (typeof result?.turn_index !== 'number' || !result.user_message_id) {
      throw new Error('追加对话轮次结果字段不完整');
    }
    return { turnIndex: result.turn_index, userMessageId: result.user_message_id };
  }

  /**
   * 生成开始：插入 streaming 占位 assistant 行并写入配置快照。
   * revision 恒为 0——同一轮的后续版本一律走 startRegeneration。
   */
  async startAssistantMessage(input: {
    sessionId: string;
    turnIndex: number;
    snapshot: GenerationSnapshot;
  }): Promise<ChatMessageRow> {
    const { data, error } = await this.db
      .from('chat_messages')
      .insert({
        session_id: input.sessionId,
        turn_index: input.turnIndex,
        role: 'assistant',
        revision: 0,
        content: '',
        status: 'streaming',
        ...snapshotColumns(input.snapshot),
      })
      .select('*')
      .single();

    if (error) throw new Error(`创建流式回复占位失败：${error.message}`);
    return data as ChatMessageRow;
  }

  /**
   * 重生成最后一轮（本轮决策 5）：旧版本置 is_active=false + 插入 revision+1 的新行，单事务。
   * turnIndex 传入时会校验它确实是最后一轮；不传由服务端取最后一轮。
   */
  async startRegeneration(input: {
    sessionId: string;
    turnIndex?: number;
    snapshot: GenerationSnapshot;
    staleAfterSeconds?: number;
  }): Promise<StartRegenerationResult> {
    const { data, error } = await this.db.rpc('start_message_regeneration', {
      p_session_id: input.sessionId,
      p_turn_index: input.turnIndex ?? null,
      p_model_id: input.snapshot.modelId,
      p_model_openrouter_id: input.snapshot.modelOpenrouterId,
      p_preset_id: input.snapshot.presetId,
      p_gen_config: input.snapshot.genConfig,
      p_stale_after_seconds: input.staleAfterSeconds ?? STREAMING_STALE_SECONDS,
    });

    if (error) throwConversationRpcError(error, '发起重生成失败');

    const result = data as {
      turn_index?: number;
      assistant_message_id?: string;
      revision?: number;
      user_content?: string;
    } | null;
    if (
      typeof result?.turn_index !== 'number' ||
      !result.assistant_message_id ||
      typeof result.revision !== 'number' ||
      typeof result.user_content !== 'string'
    ) {
      throw new Error('重生成结果字段不完整');
    }
    return {
      turnIndex: result.turn_index,
      assistantMessageId: result.assistant_message_id,
      revision: result.revision,
      userContent: result.user_content,
    };
  }

  /**
   * 流终态：一次性写完整正文与收口状态。
   * 流中断走 status='interrupted' + 已累积的 partial content，对齐 llm-proxy 的
   * stream_interrupted 语义；客户端断开不终止上游，落库的仍是完整回复（§5.6）。
   */
  async finalizeAssistantMessage(input: FinalizeAssistantMessageInput): Promise<ChatMessageRow> {
    const { data, error } = await this.db
      .from('chat_messages')
      .update({
        content: input.content,
        status: input.status,
        finish_reason: input.finishReason ?? null,
        error_code: input.errorCode ?? null,
        generation_id: input.generationId ?? null,
        charge_id: input.chargeId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.messageId)
      .eq('role', 'assistant')
      .select('*')
      .single();

    if (error) throw new Error(`收口流式回复失败：${error.message}`);
    return data as ChatMessageRow;
  }

  /** 会话详情用：默认取最近一页，向前翻页传 beforeTurnIndex */
  async listMessages(
    sessionId: string,
    options: { limit?: number; beforeTurnIndex?: number } = {}
  ): Promise<{ messages: ChatMessageRow[]; hasMore: boolean }> {
    const limit = clampLimit(options.limit, 50, 200);

    let query = this.db
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('is_active', true);

    if (typeof options.beforeTurnIndex === 'number') {
      query = query.lt('turn_index', options.beforeTurnIndex);
    }

    const { data, error } = await query
      .order('turn_index', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    if (error) throw new Error(`查询会话消息失败：${error.message}`);

    const rows = (data ?? []) as ChatMessageRow[];
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse(), hasMore };
  }

  /**
   * 上下文读取（§5.5）：有序全量，不截断。
   * 排序等价于方案里的 `turn_index ASC, CASE role WHEN 'user' THEN 0 ELSE 1 END ASC`——
   * 同一轮里 user 行必然先于 assistant 行落库，所以按 created_at 排就是同一个序，
   * 而 created_at 是 PostgREST 能直接表达的列（role 的字典序恰好相反，不能直接用）。
   */
  async getContextMessages(sessionId: string): Promise<ChatContextMessage[]> {
    const { data, error } = await this.db
      .from('chat_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .eq('is_active', true)
      .order('turn_index', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });

    if (error) throw new Error(`读取会话上下文失败：${error.message}`);
    return (data ?? []) as ChatContextMessage[];
  }

  /**
   * §5.6 的并发保护前置检查：存在未收口的 streaming 行时，M3b 在写出 SSE 首字节之前返回 409。
   * 真正的兜底在 RPC 里（同事务、带会话行锁），这里只是为了让 409 走 HTTP 状态码而不是 stream 事件。
   */
  async findStreamingAssistant(
    sessionId: string,
    staleAfterSeconds = STREAMING_STALE_SECONDS
  ): Promise<ChatMessageRow | null> {
    const threshold = new Date(Date.now() - staleAfterSeconds * 1000).toISOString();
    const { data, error } = await this.db
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('role', 'assistant')
      .eq('status', 'streaming')
      .gte('updated_at', threshold)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`查询生成中回复失败：${error.message}`);
    return (data as ChatMessageRow | null) ?? null;
  }
}

export function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    session_id: row.session_id,
    turn_index: row.turn_index,
    role: row.role,
    revision: row.revision,
    content: row.content,
    status: row.status,
    error_code: row.error_code,
    finish_reason: row.finish_reason,
    model_id: row.model_id,
    created_at: row.created_at,
  };
}

function snapshotColumns(snapshot: GenerationSnapshot) {
  return {
    model_id: snapshot.modelId,
    model_openrouter_id: snapshot.modelOpenrouterId,
    preset_id: snapshot.presetId,
    gen_config: snapshot.genConfig,
  };
}

export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}
