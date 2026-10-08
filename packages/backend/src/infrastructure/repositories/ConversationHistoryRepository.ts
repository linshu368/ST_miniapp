// 对话的唯一事实来源：experience.chat_history。**这个表只由本仓库写。**
//
// 一行代表 session 内一个 turn 的一个 revision；同轮 revision 最大者是当前版本。
// 存量 ST 行没有 session_id / turn_index / revision，本仓库不会读到它们。
//
// 一轮生成会分三段写同一行，三段的列集合基本不重叠，所以谁先落地都不会覆盖对方：
//   1. startTurn / startRegeneration  开轮 RPC 建行：身份与轮次列 + status='streaming'
//   2. setPromptHistory → finalizeTurn 请求内同步收口：prompt 快照 + 用户可见终态
//   3. saveBillingSnapshot / recordBillingOutcome / applyGenerationMetadata
//      异步补齐：请求时定价快照、扣费额、结算完成时间、OpenRouter 用量元数据
// 唯一共享的列是 llm_finish_reason：第 2 段写 SSE tap 观测值，第 3 段仅在真的从
// OpenRouter 取到更权威的值时才覆盖（它要等用量统计，必然晚于第 2 段）。
// 第 3 段的实现见 features/generation/settle.ts 与 features/generation/sync-job.ts。
// 用量元数据补齐 ≠ 结算完成：llm_billing_settled_at 有值才算扣费行、额度收口、金额回写都齐。

import { readPostprocessVersion, type ChatMessage, type ChatMessageStatus } from '@miniapp/shared';
import type { LlmModelProvider } from '@miniapp/shared';
import type { GenerationMessage, GenerationStatus } from '../../features/generation/types.js';
import { MiniappCharacterFreeQuotaRepository } from './MiniappCharacterFreeQuotaRepository.js';
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';
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
  status: string;
  upstream_status: number | null;
  deduction_rate: number | null;
  created_at: string;
  llm_finish_reason: string | null;
  llm_generation_id: string | null;
  llm_charge_id: string | null;
  llm_billing_snapshot: LlmBillingSnapshot | null;
  llm_billing_settled_at: string | null;
  session_id: string;
  turn_index: number;
  revision: number;
  /** 迁移未执行时视图没有这一列。缺失按 null，不用当前配置顶上。 */
  postprocess_version?: number | null;
}

/** 请求时定价快照。回捞按此重建 charge，不重新定价。 */
export interface LlmBillingSnapshot {
  charge_id: string;
  model_id: string | null;
  provider?: LlmModelProvider;
  provider_model_id?: string;
  model_display_name: string;
  model_markup: number;
  fixed_deduction: number;
  fixed_deduction_category: string;
  catalog_version: number;
  pricing_config_version: number;
  exchange_rate: number;
  billing_mode: 'fixed_tier';
  original_credits?: number;
  discount_rate?: number | null;
  discounted_exact?: number;
  payable_credits?: number;
  wallet_policy?: 'main_only' | 'main_then_bonus';
  requires_vip?: boolean;
  vip_active?: boolean;
  vip_valid_until?: string | null;
  model_tier?: string | null;
}

export interface ChatHistorySyncRow {
  id: string;
  user_id: string;
  model: string;
  llm_generation_id: string | null;
  llm_finish_reason: string | null;
  llm_charge_id: string | null;
  assistant_reply: string | null;
  status: string;
  llm_billing_snapshot: LlmBillingSnapshot | null;
}

export interface StartedHistoryTurn {
  turnIndex: number;
  historyId: string;
  revision: number;
  userContent: string;
  contextWindowStartTurn: number;
  /** current-version RPC 实际写入的非空正式版本。 */
  postprocessVersion: number;
}

export interface ConversationContext {
  /** 首轮实际 prompt 中保存的开场白；尚无历史时为 null，由调用方使用角色卡当前 first_mes */
  openingMessage: string | null;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 被窗口截掉的早期轮数 = context_window_start_turn - 1；未泄洪为 0 */
  truncatedTurns: number;
}

export class ConversationHistoryRepository {
  constructor(private readonly db: DomainDb = getDomainDb('experience')) {}

  async startTurn(input: {
    sessionId: string;
    userContent: string;
    model: string;
    staleAfterSeconds?: number;
    maxContextTurns?: number;
    retainContextTurns?: number;
  }): Promise<StartedHistoryTurn> {
    const windowArgs = contextWindowRpcArgs(input);
    const args = {
      p_session_id: input.sessionId,
      p_user_content: input.userContent,
      p_model: input.model,
      p_stale_after_seconds: input.staleAfterSeconds ?? STREAMING_STALE_SECONDS,
      ...windowArgs,
    };
    const data = await this.callStartRpc({
      rpc: 'start_chat_history_turn_with_current_postprocess',
      args,
      fallbackMessage: '创建对话轮次失败',
    });
    return mapStartedTurn(data, input.userContent);
  }

  async startRegeneration(input: {
    sessionId: string;
    turnIndex?: number;
    model: string;
    staleAfterSeconds?: number;
    maxContextTurns?: number;
    retainContextTurns?: number;
  }): Promise<StartedHistoryTurn> {
    const windowArgs = contextWindowRpcArgs(input);
    const args = {
      p_session_id: input.sessionId,
      p_turn_index: input.turnIndex ?? null,
      p_model: input.model,
      p_stale_after_seconds: input.staleAfterSeconds ?? STREAMING_STALE_SECONDS,
      ...windowArgs,
    };
    const data = await this.callStartRpc({
      rpc: 'start_chat_history_regeneration_with_current_postprocess',
      args,
      fallbackMessage: '发起重生成失败',
    });
    const result = data as (StartedHistoryTurnRpc & { user_content?: string }) | null;
    if (typeof result?.user_content !== 'string') {
      throw new Error('发起重生成结果字段不完整');
    }
    return mapStartedTurn(result, result.user_content);
  }

  /** 新 Backend 只调用事务内解析正式版本的 RPC；缺 migration 或配置异常必须拒绝开轮。 */
  private async callStartRpc(input: {
    rpc: string;
    args: Record<string, unknown>;
    fallbackMessage: string;
  }): Promise<StartedHistoryTurnRpc> {
    const result = await this.db.rpc(input.rpc, input.args).abortSignal(AbortSignal.timeout(5_000));
    if (result.error) throwConversationRpcError(result.error, input.fallbackMessage);
    return result.data as StartedHistoryTurnRpc;
  }

  async setPendingRequestId(historyId: string, requestId: string): Promise<void> {
    await this.setPromptHistory(historyId, [], requestId);
  }

  async setPromptHistory(
    historyId: string,
    history: GenerationMessage[],
    requestId?: string
  ): Promise<void> {
    // Correlation lives only in the stored snapshot. Never mutate messages that are
    // forwarded upstream, nor replace the opening assistant message in the prompt.
    const storedHistory = withStoredRequestId(history, requestId);
    const { error } = await this.db
      .from('chat_history')
      .update({ history: storedHistory })
      .eq('id', historyId)
      .eq('status', 'streaming')
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(`写入对话上下文快照失败：${error.message}`);
  }

  /**
   * 请求内同步收口：写用户可见终态与本轮已知的 LLM 标识。
   * 故意不碰计费金额与 OpenRouter 用量元数据，那些归 recordBillingOutcome /
   * applyGenerationMetadata，避免两个写入方抢同一列。
   */
  async finalizeTurn(input: {
    historyId: string;
    content: string;
    status: GenerationStatus;
    finishReason?: string | null;
    upstreamStatus?: number | null;
    generationId?: string | null;
    chargeId?: string | null;
  }): Promise<ConversationHistoryRow> {
    let query = this.db
      .from('chat_history')
      .update({
        assistant_reply: input.content || null,
        status: input.status,
        upstream_status: input.upstreamStatus ?? null,
        llm_finish_reason: input.finishReason ?? null,
        ...(input.generationId !== undefined ? { llm_generation_id: input.generationId } : {}),
        ...(input.chargeId !== undefined ? { llm_charge_id: input.chargeId } : {}),
      })
      .eq('id', input.historyId)
      .eq('status', 'streaming');
    // Cancellation first claims the reason while keeping the session busy until quota release.
    query = query.is('llm_finish_reason', null);
    const { data, error } = await query
      .select('*')
      .abortSignal(AbortSignal.timeout(5_000))
      .maybeSingle();
    if (error) throw new Error(`收口对话轮次失败：${error.message}`);
    // Cancellation, stale recovery and completion compete on the same persisted state.
    // A late generator must return the winner instead of replacing its terminal status.
    if (data) return data as ConversationHistoryRow;
    const current = await this.requireTurnById(input.historyId);
    if (
      current.status === 'streaming' &&
      current.llm_finish_reason !== null &&
      input.status !== 'success'
    ) {
      const claimed = await this.db
        .from('chat_history')
        .update({
          assistant_reply: input.content || null,
          status: input.status,
          llm_finish_reason: current.llm_finish_reason,
          upstream_status: input.upstreamStatus ?? null,
          ...(input.generationId !== undefined ? { llm_generation_id: input.generationId } : {}),
          ...(input.chargeId !== undefined ? { llm_charge_id: input.chargeId } : {}),
        })
        .eq('id', input.historyId)
        .eq('status', 'streaming')
        .eq('llm_finish_reason', current.llm_finish_reason)
        .select('*')
        .abortSignal(AbortSignal.timeout(5_000))
        .maybeSingle();
      if (claimed.error) throw new Error(`收口已取消对话失败：${claimed.error.message}`);
      if (claimed.data) return claimed.data as ConversationHistoryRow;
      return this.requireTurnById(input.historyId);
    }
    return current;
  }

  async registerChargeId(historyId: string, chargeId: string): Promise<void> {
    const { data, error } = await this.db
      .from('chat_history')
      .update({ llm_charge_id: chargeId })
      .eq('id', historyId)
      .eq('status', 'streaming')
      .is('llm_finish_reason', null)
      .select('id')
      .abortSignal(AbortSignal.timeout(5_000))
      .maybeSingle();
    if (error) throw new Error(`保存生成额度身份失败：${error.message}`);
    if (!data) throw new Error('回复已被取消或结束');
  }

  async requireTurnById(historyId: string): Promise<ConversationHistoryRow> {
    const { data, error } = await this.db
      .from('chat_history')
      .select('*')
      .eq('id', historyId)
      .abortSignal(AbortSignal.timeout(5_000))
      .single();
    if (error) throw new Error(`读取对话终态失败：${error.message}`);
    return data as ConversationHistoryRow;
  }

  async cancelTurn(sessionId: string, historyId: string): Promise<ConversationHistoryRow | null> {
    const { error } = await this.db
      .from('chat_history')
      .update({ llm_finish_reason: 'cancelled' })
      .eq('session_id', sessionId)
      .eq('id', historyId)
      .eq('status', 'streaming')
      .is('llm_finish_reason', null)
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(`取消对话回复失败：${error.message}`);
    // Do not unlock before the execution owner releases the free-quota reservation.
    // Bounded waiting also works across replicas; a dead owner is recovered by the stale guard.
    const deadline = Date.now() + 8_000;
    while (true) {
      const row = await this.findCurrentTurnById(sessionId, historyId);
      if (!row || row.status !== 'streaming' || Date.now() >= deadline) return row;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }

  async recoverStaleStreaming(sessionId: string): Promise<void> {
    const cutoff = new Date(Date.now() - STREAMING_STALE_SECONDS * 1000).toISOString();
    const { data, error } = await this.db
      .from('chat_history')
      .select('*')
      .eq('session_id', sessionId)
      .eq('status', 'streaming')
      .lt('created_at', cutoff)
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(`读取超时对话回复失败：${error.message}`);
    for (const candidate of (data ?? []) as ConversationHistoryRow[]) {
      // Keep streaming while reclaiming the reservation, so a new turn cannot be
      // misclassified as paid. The live worker's deadline precedes this recovery.
      const claim = await this.db
        .from('chat_history')
        .update({ llm_finish_reason: 'timeout' })
        .eq('id', candidate.id)
        .eq('status', 'streaming')
        .is('llm_finish_reason', null)
        .abortSignal(AbortSignal.timeout(5_000));
      if (claim.error) throw new Error(`标记超时对话失败：${claim.error.message}`);
      const current = await this.requireTurnById(candidate.id);
      if (current.status !== 'streaming') continue;
      if (current.llm_charge_id)
        await new MiniappCharacterFreeQuotaRepository().finalizePending(
          current.llm_charge_id,
          false
        );
      await this.finalizeTurn({
        historyId: current.id,
        content: current.assistant_reply ?? '',
        status: 'stream_interrupted',
        finishReason: current.llm_finish_reason ?? 'timeout',
      });
    }
  }

  /**
   * 生成终态结算：实扣金额 + OpenRouter 用量元数据 + 结算完成时间。
   * 由 features/generation/settle.ts 调用。
   * metadata 的键由 generation/openrouter-metadata.ts 统一构造，这里不做字段映射。
   * billingSettledAt 有值才表示扣费行、额度收口、金额回写都齐；不要用元数据是否齐全代替。
   */
  async recordBillingOutcome(input: {
    historyId: string;
    deductionRate: number;
    metadata: Record<string, unknown>;
    billingSettledAt?: string;
  }): Promise<void> {
    const { error } = await this.db
      .from('chat_history')
      .update({
        deduction_rate: input.deductionRate,
        ...withoutFinishReason(input.metadata),
        ...(input.billingSettledAt ? { llm_billing_settled_at: input.billingSettledAt } : {}),
      })
      .eq('id', input.historyId);
    if (error) throw new Error(`回写生成计费结果失败：${error.message}`);
    await this.applySuccessfulFinishReason(input.historyId, input.metadata);
  }

  /**
   * 扣费前先落下请求时定价快照。charge 行还没建出来时，回捞靠它按原价补建。
   * 由 features/generation/settle.ts 调用；不碰用量元数据列。
   */
  async saveBillingSnapshot(historyId: string, snapshot: LlmBillingSnapshot): Promise<void> {
    const { error } = await this.db
      .from('chat_history')
      .update({ llm_billing_snapshot: snapshot })
      .eq('id', historyId);
    if (error) throw new Error(`回写计费快照失败：${error.message}`);
  }

  /**
   * 回捞任务的元数据补齐：覆盖 llm_* 用量字段与（若已结算）扣费额、结算完成时间。
   * 由 features/generation/sync-job.ts 调用。
   */
  async applyGenerationMetadata(
    historyId: string,
    metadata: Record<string, unknown>,
    billingSettledAt?: string
  ): Promise<void> {
    const { error } = await this.db
      .from('chat_history')
      .update({
        ...withoutFinishReason(metadata),
        ...(billingSettledAt ? { llm_billing_settled_at: billingSettledAt } : {}),
      })
      .eq('id', historyId);
    if (error) throw new Error(`补齐 LLM 元数据失败：${error.message}`);
    await this.applySuccessfulFinishReason(historyId, metadata);
  }

  private async applySuccessfulFinishReason(
    historyId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    if (typeof metadata.llm_finish_reason !== 'string') return;
    const { error } = await this.db
      .from('chat_history')
      .update({ llm_finish_reason: metadata.llm_finish_reason })
      .eq('id', historyId)
      .eq('status', 'success')
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(`补齐生成完成原因失败：${error.message}`);
  }

  /**
   * 回捞任务的扫描口：24h 内有 generation_id，且用量字段不全或结算未完成的行。
   * 结算未完成 = 已有请求时快照但还没有 llm_billing_settled_at。
   * 没有快照的存量行仍只按用量字段不全扫描，避免把 24h 内已结清的历史行整批拖进来。
   */
  async listRowsMissingGenerationData(input: {
    since: string;
    limit: number;
  }): Promise<ChatHistorySyncRow[]> {
    const { data, error } = await this.db
      .from('chat_history')
      .select(
        'id, user_id, model, llm_generation_id, llm_finish_reason, llm_charge_id, assistant_reply, status, llm_billing_snapshot'
      )
      .not('llm_generation_id', 'is', null)
      .gte('created_at', input.since)
      // llm_usage_cache 不参与判定：OpenRouter 从不返回 usage_cache，把它算进来会让窗口内
      // 每一行都恒为「不完整」，被反复重新拉取直到滚出 24h。
      .or(
        'llm_generation_data.is.null,llm_usage.is.null,llm_latency.is.null,llm_generation_time.is.null,llm_finish_reason.is.null,and(llm_billing_snapshot.not.is.null,llm_billing_settled_at.is.null)'
      )
      .order('created_at', { ascending: false })
      .limit(input.limit);

    if (error) throw new Error(`扫描待补齐的对话轮次失败：${error.message}`);
    return (data ?? []) as ChatHistorySyncRow[];
  }

  /**
   * 返回 current turn 之前、窗口起点之后的当前版本上下文。
   * 开场白始终从 turn 1 的 prompt 快照提取，不随泄洪丢掉。
   * listMessages 不加这个过滤。
   */
  async getContextBeforeTurn(sessionId: string, turnIndex: number): Promise<ConversationContext> {
    const windowStartTurn = await this.readWindowStartTurn(sessionId);

    const windowQuery = this.db
      .from('current_chat_history')
      .select('*')
      .eq('session_id', sessionId)
      .gte('turn_index', windowStartTurn)
      .lt('turn_index', turnIndex)
      .order('turn_index', { ascending: true })
      .abortSignal(AbortSignal.timeout(5_000));

    if (windowStartTurn <= 1) {
      const { data, error } = await windowQuery;
      if (error) throw new Error(`读取会话上下文失败：${error.message}`);
      return assembleConversationContext({
        windowStartTurn,
        windowRows: (data ?? []) as ConversationHistoryRow[],
      });
    }

    const [windowResult, openingResult] = await Promise.all([
      windowQuery,
      this.db
        .from('current_chat_history')
        .select('history')
        .eq('session_id', sessionId)
        .eq('turn_index', 1)
        .abortSignal(AbortSignal.timeout(5_000))
        .maybeSingle(),
    ]);
    if (windowResult.error) throw new Error(`读取会话上下文失败：${windowResult.error.message}`);
    if (openingResult.error) throw new Error(`读取开场白快照失败：${openingResult.error.message}`);

    return assembleConversationContext({
      windowStartTurn,
      windowRows: (windowResult.data ?? []) as ConversationHistoryRow[],
      openingHistory: (openingResult.data as { history?: unknown[] } | null)?.history,
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
   * 走 current_chat_history 而不是 chat_history：只有当前版本的回复才在页面上，
   * 被重生成顶掉的旧版本用户已经看不到了，不该还能为它生成语音。
   */
  async findCurrentTurnById(
    sessionId: string,
    historyId: string
  ): Promise<ConversationHistoryRow | null> {
    const { data, error } = await this.db
      .from('current_chat_history')
      .select('*')
      .eq('id', historyId)
      .eq('session_id', sessionId)
      .abortSignal(AbortSignal.timeout(5_000))
      .maybeSingle();

    if (error) throw new Error(`查询对话轮次失败：${error.message}`);
    return (data as ConversationHistoryRow | null) ?? null;
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

interface StartedHistoryTurnRpc {
  turn_index?: number;
  history_id?: string;
  revision?: number;
  context_window_start_turn?: number;
  postprocess_version?: number | null;
}

function mapStartedTurn(
  result: StartedHistoryTurnRpc | null,
  userContent: string
): StartedHistoryTurn {
  const postprocessVersion = readPostprocessVersion(result?.postprocess_version);
  if (
    typeof result?.turn_index !== 'number' ||
    !result.history_id ||
    typeof result.revision !== 'number' ||
    postprocessVersion === null
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
  };
}

function contextWindowRpcArgs(input: { maxContextTurns?: number; retainContextTurns?: number }): {
  p_max_context_turns?: number;
  p_retain_context_turns?: number;
} {
  return {
    ...(typeof input.maxContextTurns === 'number'
      ? { p_max_context_turns: input.maxContextTurns }
      : {}),
    ...(typeof input.retainContextTurns === 'number'
      ? { p_retain_context_turns: input.retainContextTurns }
      : {}),
  };
}

function readWindowStart(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

export function assembleConversationContext(input: {
  windowStartTurn: number;
  windowRows: ConversationHistoryRow[];
  openingHistory?: unknown[];
}): ConversationContext {
  const openingSource = input.openingHistory ?? input.windowRows[0]?.history;
  return {
    openingMessage: extractOpeningMessage(openingSource),
    messages: input.windowRows.flatMap((row) => {
      const messages: ConversationContext['messages'] = [{ role: 'user', content: row.user_input }];
      if (row.assistant_reply?.trim()) {
        messages.push({ role: 'assistant', content: row.assistant_reply });
      }
      return messages;
    }),
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
      postprocess_version: null,
      created_at: row.created_at,
    },
    {
      id: row.id,
      ...(extractRequestId(row.history) ? { request_id: extractRequestId(row.history)! } : {}),
      session_id: row.session_id,
      turn_index: row.turn_index,
      role: 'assistant',
      revision: row.revision,
      content: row.assistant_reply ?? '',
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

function withoutFinishReason(metadata: Record<string, unknown>): Record<string, unknown> {
  const { llm_finish_reason: _finishReason, ...rest } = metadata;
  return rest;
}

export function withStoredRequestId(
  history: GenerationMessage[],
  requestId?: string
): Array<GenerationMessage & { request_id?: string }> {
  if (!requestId) return history;
  const first = history[0] ?? { role: 'system', content: '' };
  return [{ ...first, request_id: requestId }, ...history.slice(1)];
}

function extractRequestId(history: unknown[]): string | undefined {
  const first = history[0];
  if (!first || typeof first !== 'object') return undefined;
  const requestId = (first as { request_id?: unknown }).request_id;
  return typeof requestId === 'string' ? requestId : undefined;
}
