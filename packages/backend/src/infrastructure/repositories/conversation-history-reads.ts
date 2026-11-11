import type { ChatMessage } from '@miniapp/shared';
import type { DomainDb } from '../../lib/supabase.js';
import {
  assembleConversationContext,
  clampLimit,
  readWindowStart,
  toChatMessages,
  toOpeningMessage,
} from './conversation-history-mapping.js';
import type { ConversationContext, ConversationHistoryRow } from './conversation-history-types.js';
import { readConversationPage } from './conversation-page-retry.js';

const MESSAGE_DISPLAY_COLUMNS =
  'id,user_id,model,user_input,assistant_reply,character_id,status,upstream_status,deduction_rate,created_at,llm_finish_reason,llm_charge_id,session_id,turn_index,revision,postprocess_version,first_token_preview,is_inherited,liked,user_deleted,assistant_deleted,user_edit_version,assistant_edit_version,display_request_id,display_opening_message,display_fallback';

export class ConversationHistoryReads {
  constructor(private readonly db: DomainDb) {}
  /**
   * 返回 current turn 之前、窗口起点之后的当前版本上下文。
   * 开场白取 turn 1 的展示投影，不随泄洪丢掉；未回填记录由视图兼容提取。
   * listMessages 不加这个过滤。
   *
   * knownWindowStartTurn：开轮 RPC 刚返回的窗口起点。调用方有就传，省掉一次 chat_sessions 读；
   * 没有（如生图按已存在的轮次组上下文）时仍回读会话。
   */
  async getContextBeforeTurn(
    sessionId: string,
    turnIndex: number,
    knownWindowStartTurn?: number
  ): Promise<ConversationContext> {
    const windowStartTurn =
      knownWindowStartTurn === undefined
        ? await this.readWindowStartTurn(sessionId)
        : readWindowStart(knownWindowStartTurn);

    const base = this.db
      .from('session_chat_display')
      .select('turn_index,user_input,assistant_reply,display_opening_message')
      .eq('session_id', sessionId);

    // 已泄洪时窗口不含 turn 1，但开场白仍要保留 turn 1 的值。
    // 用一条 OR 查询同时取回两者，而不是并发两次 GET：同一 session 连续打两次
    // current_chat_history 正是 ST-MINIAPP-2G（Consecutive HTTP）报的问题。
    const filtered =
      windowStartTurn <= 1
        ? base.gte('turn_index', windowStartTurn).lt('turn_index', turnIndex)
        : base.or(
            `turn_index.eq.1,and(turn_index.gte.${windowStartTurn},turn_index.lt.${turnIndex})`
          );

    const { data, error } = await filtered
      .order('turn_index', { ascending: true })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(`读取会话上下文失败：${error.message}`);

    const rows = (data ?? []) as unknown as ConversationHistoryRow[];
    if (windowStartTurn <= 1) {
      return assembleConversationContext({ windowStartTurn, windowRows: rows });
    }

    return assembleConversationContext({
      windowStartTurn,
      windowRows: rows.filter((row) => row.turn_index >= windowStartTurn),
      openingMessage: rows.find((row) => row.turn_index === 1)?.display_opening_message,
    });
  }

  private async readWindowStartTurn(sessionId: string): Promise<number> {
    const { data, error } = await this.db
      .from('chat_sessions')
      .select('context_window_start_turn')
      .eq('id', sessionId)
      .abortSignal(AbortSignal.timeout(5_000))
      .maybeSingle();
    if (error) throw new Error(`读取上下文窗口起点失败：${error.message}`);
    return readWindowStart(
      (data as { context_window_start_turn?: unknown } | null)?.context_window_start_turn
    );
  }

  /**
   * 按 id 取一轮，并确认它属于该会话。语音生成要拿这条回复的正文。
   *
   * 走 session_chat_display 的当前版本语义：只有当前版本的回复才在页面上，
   * 被重生成顶掉的旧版本用户已经看不到了，不该还能为它生成语音。
   */
  async findCurrentTurnById(
    sessionId: string,
    historyId: string
  ): Promise<ConversationHistoryRow | null> {
    const { data, error } = await this.db
      .from('session_chat_display')
      .select(MESSAGE_DISPLAY_COLUMNS)
      .eq('is_inherited', false)
      .eq('id', historyId)
      .eq('session_id', sessionId)
      .abortSignal(AbortSignal.timeout(5_000))
      .maybeSingle();

    if (error) throw new Error(`查询对话轮次失败：${error.message}`);
    return data as unknown as ConversationHistoryRow | null;
  }

  async listMessages(
    sessionId: string,
    openingMessage: string,
    options: { userId: string; limit?: number; beforeTurnIndex?: number; signal?: AbortSignal }
  ): Promise<{
    messages: ChatMessage[];
    hasMore: boolean;
    diagnostics: { attempts: number; elapsedMs: number; fallbackCount: number };
  }> {
    const turnLimit = Math.max(Math.ceil(clampLimit(options.limit, 50, 200) / 2), 1);
    const result = await readConversationPage(
      (signal) =>
        this.db
          .rpc('list_chat_message_page', {
            p_user_id: options.userId,
            p_session_id: sessionId,
            p_before_turn_index: options.beforeTurnIndex ?? null,
            p_turn_limit: turnLimit,
          })
          .abortSignal(signal),
      options.signal
    );
    if (!Array.isArray(result.data) || result.data.length > turnLimit + 1) {
      throw new Error('Invalid conversation page result');
    }
    const latest = result.data as ConversationHistoryRow[];
    if (
      latest.some(
        (row) => row.session_id !== sessionId || !row.id || !Number.isInteger(row.turn_index)
      )
    ) {
      throw new Error('Invalid conversation page identity');
    }
    // Keep the transport's serialization order out of the cursor contract.
    latest.sort((left, right) => right.turn_index - left.turn_index);
    if (new Set(latest.map((row) => row.turn_index)).size !== latest.length) {
      throw new Error('Duplicate conversation page turn');
    }
    const hasMore = latest.length > turnLimit;
    const page = latest.slice(0, turnLimit).reverse();
    const persistedOpening = page[0]?.display_opening_message ?? null;
    const messages = page.flatMap(toChatMessages);
    if (!hasMore && (persistedOpening ?? openingMessage).trim()) {
      messages.unshift(toOpeningMessage(sessionId, persistedOpening ?? openingMessage));
    }
    return {
      messages,
      hasMore,
      diagnostics: {
        attempts: result.attempts,
        elapsedMs: result.elapsedMs,
        fallbackCount: latest.filter((row) => row.display_fallback).length,
      },
    };
  }
}
