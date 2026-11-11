import { STREAMING_STALE_SECONDS } from './conversation-history-types.js';
// Public conversation repository facade; generation identity/prompt writes live
// in the atomic admission RPC. Display reads never require provider snapshots.
import {
  splitEditableReply,
  type CancelConversationTurnRequest,
  type ChangeChatMessageData,
  type ChangeChatMessageRequest,
  type SetMessageLikeData,
} from '@miniapp/shared';
import type { GenerationMessage, GenerationStatus } from '../../features/generation/types.js';
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';
import { ConversationRepositoryError, throwConversationRpcError } from './conversation-errors.js';
import * as billing from './conversation-history-billing.js';
import {
  mapStartedTurn,
  withStoredRequestId,
  type StartedHistoryTurnRpc,
} from './conversation-history-mapping.js';
import { ConversationHistoryReads } from './conversation-history-reads.js';
import type { ConversationHistoryRow, StartedHistoryTurn } from './conversation-history-types.js';
import { MiniappCharacterFreeQuotaRepository } from './MiniappCharacterFreeQuotaRepository.js';
export {
  assembleConversationContext,
  clampLimit,
  extractOpeningMessage,
  latestRevisionRows,
  toChatMessages,
  toChatMessageStatus,
  toOpeningMessage,
  withStoredRequestId,
} from './conversation-history-mapping.js';
export * from './conversation-history-types.js';
export { STREAMING_STALE_SECONDS } from './conversation-history-types.js';
const TURN_COLUMNS =
  'id,user_id,model,user_input,assistant_reply,character_id,status,upstream_status,deduction_rate,created_at,llm_finish_reason,llm_charge_id,session_id,turn_index,revision,postprocess_version,rich_reply_metadata,first_token_preview,llm_billing_snapshot,llm_billing_settled_at';

export class ConversationHistoryRepository {
  private readonly reads: ConversationHistoryReads;
  constructor(private readonly db: DomainDb = getDomainDb('experience')) {
    this.reads = new ConversationHistoryReads(db);
  }

  async changeMessage(input: {
    userId: string;
    sessionId: string;
    messageId: string;
    body: ChangeChatMessageRequest;
  }): Promise<ChangeChatMessageData> {
    let content = input.body.action === 'edit' ? input.body.content : null;
    if (input.body.action === 'edit' && input.body.role === 'assistant') {
      const { data: current, error: readError } = await this.db
        .from('session_chat_history')
        .select('assistant_reply')
        .eq('session_id', input.sessionId)
        .eq('user_id', input.userId)
        .eq('id', input.messageId)
        .abortSignal(AbortSignal.timeout(5_000))
        .maybeSingle();
      if (readError) throw new Error('读取原回复失败，请重试');
      if (!current)
        throw new ConversationRepositoryError('message_change_not_allowed', '这条消息暂时无法修改');
      // The RPC rechecks the same version under its session lock, so a concurrent
      // edit/delete can never make us attach panels from a different revision.
      const tail = splitEditableReply(current.assistant_reply ?? '').protectedTail;
      content = input.body.content + tail;
      if (content.length > 65_536)
        throw new ConversationRepositoryError('message_change_not_allowed', '正文过长，请适当缩短');
    }
    const { data, error } = await this.db
      .rpc('change_chat_message', {
        p_user_id: input.userId,
        p_session_id: input.sessionId,
        p_message_id: input.messageId,
        p_role: input.body.role,
        p_action: input.body.action,
        p_expected_version: input.body.expected_version,
        p_content: content,
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throwConversationRpcError(error, '修改消息失败');
    const result = data as ChangeChatMessageData | null;
    if (
      result?.session_id !== input.sessionId ||
      result.message_id !== input.messageId ||
      result.role !== input.body.role ||
      typeof result.content !== 'string' ||
      typeof result.deleted !== 'boolean' ||
      !Number.isInteger(result.edit_version)
    )
      throw new Error('修改消息结果字段不完整');
    return result;
  }

  /** Explicit target state makes retries safe; the RPC owns session/revision authorization. */
  async setMessageLike(input: {
    userId: string;
    sessionId: string;
    messageId: string;
    liked: boolean;
  }): Promise<SetMessageLikeData> {
    const { data, error } = await this.db
      .rpc('set_chat_message_like', {
        p_user_id: input.userId,
        p_session_id: input.sessionId,
        p_message_id: input.messageId,
        p_liked: input.liked,
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throwConversationRpcError(error, '更新回复点赞失败');
    const result = data as SetMessageLikeData | null;
    if (
      result?.session_id !== input.sessionId ||
      result.message_id !== input.messageId ||
      result.liked !== input.liked
    ) {
      throw new Error('更新回复点赞结果字段不完整');
    }
    return { session_id: result.session_id, message_id: result.message_id, liked: result.liked };
  }

  async startTurn(input: {
    sessionId: string;
    userContent: string;
    model: string;
    staleAfterSeconds?: number;
  }): Promise<StartedHistoryTurn> {
    const args = {
      p_session_id: input.sessionId,
      p_user_content: input.userContent,
      p_model: input.model,
      p_stale_after_seconds: input.staleAfterSeconds ?? STREAMING_STALE_SECONDS,
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
  }): Promise<StartedHistoryTurn> {
    const args = {
      p_session_id: input.sessionId,
      p_turn_index: input.turnIndex ?? null,
      p_model: input.model,
      p_stale_after_seconds: input.staleAfterSeconds ?? STREAMING_STALE_SECONDS,
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

  async saveRichReplyMetadata(
    historyId: string,
    metadata: {
      rich_reply_mode: 'full' | 'concise';
      rich_reply_result: 'exact' | 'recovered' | 'failed';
      rich_reply_issues: string[];
    }
  ): Promise<void> {
    const { error } = await this.db
      .from('chat_history')
      .update({ rich_reply_metadata: metadata })
      .eq('id', historyId)
      .eq('status', 'success')
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(`写入富文本协议诊断失败：${error.message}`);
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
   * 请求内同步收口：写正文与用户可见终态，调用身份只留在 provider 明细。
   * 计费金额归 recordBillingOutcome，OpenRouter 元数据归专表，避免两个写入方抢同一列。
   */
  async finalizeTurn(input: {
    historyId: string;
    content: string;
    status: GenerationStatus;
    finishReason?: string | null;
    upstreamStatus?: number | null;
    chargeId?: string | null;
  }): Promise<ConversationHistoryRow> {
    let query = this.db
      .from('chat_history')
      .update({
        assistant_reply: input.content || null,
        status: input.status,
        upstream_status: input.upstreamStatus ?? null,
        llm_finish_reason: input.finishReason ?? null,
        ...(input.chargeId !== undefined ? { llm_charge_id: input.chargeId } : {}),
      })
      .eq('id', input.historyId)
      .eq('status', 'streaming');
    // Cancellation first claims the reason while keeping the session busy until quota release.
    query = query.is('llm_finish_reason', null);
    const { data, error } = await query
      .select(TURN_COLUMNS)
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
          ...(input.chargeId !== undefined ? { llm_charge_id: input.chargeId } : {}),
        })
        .eq('id', input.historyId)
        .eq('status', 'streaming')
        .eq('llm_finish_reason', current.llm_finish_reason)
        .select(TURN_COLUMNS)
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
      .select(TURN_COLUMNS)
      .eq('id', historyId)
      .abortSignal(AbortSignal.timeout(5_000))
      .single();
    if (error) throw new Error(`读取对话终态失败：${error.message}`);
    return data as ConversationHistoryRow;
  }

  /** Cancellation polling must not fetch/detoast the full prompt or reply every second. */
  async requireTurnState(
    historyId: string
  ): Promise<Pick<ConversationHistoryRow, 'status' | 'llm_finish_reason'>> {
    const { data, error } = await this.db
      .from('chat_history')
      .select('status,llm_finish_reason')
      .eq('id', historyId)
      .abortSignal(AbortSignal.timeout(5_000))
      .single();
    if (error) throw new Error(`读取对话状态失败：${error.message}`);
    return data;
  }

  async cancelTurn(
    sessionId: string,
    historyId: string,
    reason?: CancelConversationTurnRequest['reason']
  ): Promise<ConversationHistoryRow | null> {
    // The persisted request policy decides manual stop versus a proven system
    // deadline. Optional client intent cannot itself waive a valid charge.
    const { error } = await this.db
      .rpc('cancel_chat_generation', {
        p_session_id: sessionId,
        p_history_id: historyId,
        p_reason: reason ?? null,
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(`取消对话回复失败：${error.message}`);
    // Do not unlock before the execution owner finalizes the free-quota reservation.
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
      .select(TURN_COLUMNS)
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

  recordBillingOutcome(
    ...args: Parameters<typeof billing.recordBillingOutcome> extends [DomainDb, ...infer Rest]
      ? Rest
      : never
  ) {
    return billing.recordBillingOutcome(this.db, ...args);
  }

  saveBillingSnapshot(
    ...args: Parameters<typeof billing.saveBillingSnapshot> extends [DomainDb, ...infer Rest]
      ? Rest
      : never
  ) {
    return billing.saveBillingSnapshot(this.db, ...args);
  }

  listRowsPendingBilling(
    ...args: Parameters<typeof billing.listRowsPendingBilling> extends [DomainDb, ...infer Rest]
      ? Rest
      : never
  ) {
    return billing.listRowsPendingBilling(this.db, ...args);
  }

  listRowsMissingProviderIdentity(
    ...args: Parameters<typeof billing.listRowsMissingProviderIdentity> extends [
      DomainDb,
      ...infer Rest,
    ]
      ? Rest
      : never
  ) {
    return billing.listRowsMissingProviderIdentity(this.db, ...args);
  }

  listStaleStreaming(
    ...args: Parameters<typeof billing.listStaleStreaming> extends [DomainDb, ...infer Rest]
      ? Rest
      : never
  ) {
    return billing.listStaleStreaming(this.db, ...args);
  }

  getContextBeforeTurn(...args: Parameters<ConversationHistoryReads['getContextBeforeTurn']>) {
    return this.reads.getContextBeforeTurn(...args);
  }

  findCurrentTurnById(...args: Parameters<ConversationHistoryReads['findCurrentTurnById']>) {
    return this.reads.findCurrentTurnById(...args);
  }

  listMessages(...args: Parameters<ConversationHistoryReads['listMessages']>) {
    return this.reads.listMessages(...args);
  }
}
