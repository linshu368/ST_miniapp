import type {
  ImageGenerationTier,
  ImageErrorCode,
  ImagePromptSource,
  MediaBillingMode,
  MessageImageAttempt,
  MessageImageState,
  MessageImageStatus,
  WalletDebitPolicy,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import { FeatureFreeTrialRepository } from './FeatureFreeTrialRepository.js';

type NumericValue = string | number;

export class ImageConflictError extends Error {
  constructor() {
    super('这条回复正在生成图片');
    this.name = 'ImageConflictError';
  }
}

export interface ChatMessageImageRow {
  id: string;
  user_id: string;
  session_id: string;
  message_id: string;
  attempt_no: number;
  /** 图片生成等级：basic、advanced */
  image_tier: ImageGenerationTier | null;
  prompt_cn: string | null;
  prompt_source: ImagePromptSource | null;
  description_user_prompt: string | null;
  prompt_en: string | null;
  provider_prompt: string | null;
  provider: string;
  model: string;
  base_url_host: string | null;
  width: number;
  height: number;
  output_format: string;
  price_credits: NumericValue;
  price_label: string;
  /** 计费模式：免费体验、付费 */
  billing_mode: MediaBillingMode | null;
  /** 免费体验次数：1、2、3 */
  free_trial_ordinal: number | null;
  /** 计费额度：星尘 */
  wallet_policy: WalletDebitPolicy | null;
  /** 会员有效期：时间戳 */
  vip_valid_until: string | null;
  status: ImageInternalStatus;
  is_current: boolean;
  lease_owner: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string;
  stage: string | null;
  provider_request_id: string | null;
  storage_path: string | null;
  image_url: string | null;
  mime_type: 'image/webp' | 'image/png' | 'image/jpeg' | null;
  byte_size: number | null;
  latency_ms: number | null;
  error_code: ImageErrorCode | null;
  credits_charged: NumericValue;
  debit_ledger_id: string | null;
  charged_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

type ImageInternalStatus =
  | 'draft_describing'
  | 'draft_ready'
  | 'draft_failed'
  | 'pending'
  | 'leased'
  | 'generating'
  | 'storing'
  | 'ready'
  | 'failed'
  | 'failed_unknown';

interface SettlementResult {
  charge_status?:
    | 'charged'
    | 'already_charged'
    | 'free_trial_consumed'
    | 'already_free_trial_consumed'
    | 'insufficient_balance'
    | 'free_trial_invalid';
  ledger_id?: string | null;
  required?: NumericValue;
  available?: NumericValue;
}

export class ChatMessageImageRepository {
  private readonly db = getDomainDb('experience');
  private readonly billingDb = getDomainDb('billing');
  /** 免费体验仓库 */
  private readonly freeTrials = new FeatureFreeTrialRepository();

  async listBySession(sessionId: string): Promise<MessageImageState[]> {
    const { data, error } = await this.db
      .from('chat_message_images')
      .select('*')
      .eq('session_id', sessionId)
      .not('status', 'in', '(draft_describing,draft_ready,draft_failed)')
      .order('created_at', { ascending: false });

    if (error) throw new Error(`查询会话图片失败：${error.message}`);

    const byMessage = new Map<string, ChatMessageImageRow[]>();
    for (const row of (data ?? []) as ChatMessageImageRow[]) {
      const rows = byMessage.get(row.message_id);
      if (rows) rows.push(row);
      else byMessage.set(row.message_id, [row]);
    }

    const states: MessageImageState[] = [];
    for (const [messageId, rows] of byMessage.entries()) {
      const latest = rows[0];
      if (!latest) continue;
      const current = rows.find((row) => row.is_current && row.status === 'ready') ?? null;
      states.push({
        message_id: messageId,
        current: current ? toMessageImageAttempt(current) : null,
        latest: toMessageImageAttempt(latest),
      });
    }
    return states;
  }

  async createPending(input: {
    id?: string;
    userId: string;
    sessionId: string;
    messageId: string;
    /** 图片生成等级：basic、advanced */
    tier: ImageGenerationTier;
    promptCn: string;
    promptSource: ImagePromptSource;
    /** 图片生成提供商：liaobots_grok、replicate_z */
    provider: 'liaobots_grok' | 'replicate_z';
    model: string;
    baseUrlHost: string | null;
    width: number;
    height: number;
    priceCredits: number;
    priceLabel: string;
    /** 计费模式：免费体验、付费 */
    billingMode: MediaBillingMode;
    /** 免费体验次数：1、2、3 */
    freeTrialOrdinal: number | null;
    /** 钱包扣费策略：main_only、main_and_bonus */
    walletPolicy: WalletDebitPolicy;
    /** 会员有效期：时间戳 */
    vipValidUntil: string | null;
  }): Promise<ChatMessageImageRow> {
    const inflight = await this.findInflightByMessage(input.messageId);
    if (inflight) throw new ImageConflictError();

    const attemptNo = (await this.readMaxAttemptNo(input.messageId)) + 1;
    const { data, error } = await this.db
      .from('chat_message_images')
      .insert({
        ...(input.id ? { id: input.id } : {}),
        user_id: input.userId,
        session_id: input.sessionId,
        message_id: input.messageId,
        attempt_no: attemptNo,
        /** 图片生成等级：basic、advanced */
        image_tier: input.tier,
        prompt_cn: input.promptCn,
        prompt_source: input.promptSource,
        provider: input.provider,
        model: input.model,
        base_url_host: input.baseUrlHost,
        width: input.width,
        height: input.height,
        output_format: 'webp',
        price_credits: input.priceCredits,
        price_label: input.priceLabel,
        /** 计费模式：免费体验、付费 */
        billing_mode: input.billingMode,
        /** 免费体验次数：1、2、3 */
        free_trial_ordinal: input.freeTrialOrdinal,
        /** 钱包扣费策略：main_only、main_and_bonus */
        wallet_policy: input.walletPolicy,
        /** 会员有效期：时间戳 */
        vip_valid_until: input.vipValidUntil,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') throw new ImageConflictError();
      throw new Error(`创建图片生成记录失败：${error.message}`);
    }
    return data as ChatMessageImageRow;
  }

  /** 在写稿模型调用前创建 draft 并保存完整 user prompt；插入失败时调用方不得请求上游。 */
  async createDescriptionDraft(input: {
    userId: string;
    sessionId: string;
    messageId: string;
    userPrompt: string;
    /** 图片生成等级：basic、advanced */
    tier: ImageGenerationTier;
    /** 图片生成提供商：liaobots_grok、replicate_z */
    provider: 'liaobots_grok' | 'replicate_z';
    model: string;
    baseUrlHost: string | null;
    width: number;
    height: number;
    priceCredits: number;
    priceLabel: string;
  }): Promise<ChatMessageImageRow> {
    await this.deleteDescriptionDrafts({
      userId: input.userId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      includeInflight: false,
    });
    const attemptNo = (await this.readMaxAttemptNo(input.messageId)) + 1;
    const { data, error } = await this.db
      .from('chat_message_images')
      .insert({
        user_id: input.userId,
        session_id: input.sessionId,
        message_id: input.messageId,
        attempt_no: attemptNo,
        /** 图片生成等级：basic、advanced */
        image_tier: input.tier,
        description_user_prompt: input.userPrompt,
        provider: input.provider,
        model: input.model,
        base_url_host: input.baseUrlHost,
        width: input.width,
        height: input.height,
        output_format: 'webp',
        price_credits: input.priceCredits,
        price_label: input.priceLabel,
        status: 'draft_describing',
        stage: 'description',
      })
      .select('*')
      .single();
    if (error) throw new Error(`创建图片描述草稿失败：${error.message}`);
    return data as ChatMessageImageRow;
  }

  async markDescriptionDraftReady(id: string, promptCn: string): Promise<void> {
    await this.update(id, {
      status: 'draft_ready',
      stage: 'description_ready',
      prompt_cn: promptCn,
      prompt_source: 'generated',
      updated_at: new Date().toISOString(),
    });
  }

  async markDescriptionDraftFailed(id: string, errorCode: ImageErrorCode): Promise<void> {
    await this.update(id, {
      status: 'draft_failed',
      stage: 'description_failed',
      error_code: errorCode,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  /** 只允许草稿所有者把绑定当前消息的 draft_ready 原子推进为 pending。 */
  async confirmDescriptionDraft(input: {
    id: string;
    userId: string;
    sessionId: string;
    messageId: string;
    /** 图片生成等级：basic、advanced */
    tier: ImageGenerationTier;
    promptCn: string;
    promptSource: ImagePromptSource;
    /** 图片生成提供商：liaobots_grok、replicate_z */
    provider: 'liaobots_grok' | 'replicate_z';
    /** 模型：grok、z */
    model: string;
    /** 图片生成提供商基础 URL 主机：https://grok.com、https://z.com */
    baseUrlHost: string | null;
    /** 图片宽度：1024、2048、4096 */
    width: number;
    /** 图片高度：1024、2048、4096 */
    height: number;
    /** 计费额度：星尘 */
    priceCredits: number;
    /** 计费标签：免费体验、付费 */
    priceLabel: string;
    /** 计费模式：免费体验、付费 */
    billingMode: MediaBillingMode;
    /** 免费体验次数：1、2、3 */
    freeTrialOrdinal: number | null;
    /** 钱包扣费策略：main_only、main_and_bonus */
    walletPolicy: WalletDebitPolicy;
    /** 会员有效期：时间戳 */
    vipValidUntil: string | null;
  }): Promise<ChatMessageImageRow> {
    const { data, error } = await this.db
      .from('chat_message_images')
      .update({
        image_tier: input.tier,
        prompt_cn: input.promptCn,
        prompt_source: input.promptSource,
        provider: input.provider,
        model: input.model,
        base_url_host: input.baseUrlHost,
        width: input.width,
        height: input.height,
        price_credits: input.priceCredits,
        price_label: input.priceLabel,
        billing_mode: input.billingMode,
        free_trial_ordinal: input.freeTrialOrdinal,
        wallet_policy: input.walletPolicy,
        vip_valid_until: input.vipValidUntil,
        status: 'pending',
        stage: 'pending',
        next_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.id)
      .eq('user_id', input.userId)
      .eq('session_id', input.sessionId)
      .eq('message_id', input.messageId)
      .eq('image_tier', input.tier)
      .eq('status', 'draft_ready')
      .select('*')
      .maybeSingle();
    if (error?.code === '23505') throw new ImageConflictError();
    if (error) throw new Error(`确认图片描述草稿失败：${error.message}`);
    if (!data) throw new ImageConflictError();
    await this.deleteDescriptionDrafts({
      userId: input.userId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      excludeId: input.id,
      includeInflight: true,
    });
    return data as ChatMessageImageRow;
  }

  async claim(
    limit: number,
    workerId: string,
    leaseSeconds: number
  ): Promise<ChatMessageImageRow[]> {
    const { data, error } = await this.db.rpc('claim_chat_image_jobs', {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error(`领取图片生成任务失败：${error.message}`);
    return (data ?? []) as ChatMessageImageRow[];
  }

  async findById(id: string): Promise<ChatMessageImageRow | null> {
    const { data, error } = await this.db
      .from('chat_message_images')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`查询图片生成记录失败：${error.message}`);
    return (data as ChatMessageImageRow | null) ?? null;
  }

  /** 原子保存内部 prompt 并跨过 provider dispatch 边界；此后任务不得因租约过期自动重投。 */
  async markProviderDispatch(id: string, promptEn: string, providerPrompt: string): Promise<void> {
    await this.update(id, {
      status: 'generating',
      stage: 'provider_dispatch',
      prompt_en: promptEn,
      provider_prompt: providerPrompt,
      provider_request_id: id,
      updated_at: new Date().toISOString(),
    });
  }

  /** Grok 明确失败或传输失败后记录实际降级通道，保证 attempt 审计不仍显示主 provider。 */
  async markProviderFallback(input: {
    id: string;
    provider: string;
    model: string;
    baseUrlHost: string | null;
  }): Promise<void> {
    await this.update(input.id, {
      provider: input.provider,
      model: input.model,
      base_url_host: input.baseUrlHost,
      stage: 'provider_fallback_dispatch',
      provider_request_id: input.id,
      updated_at: new Date().toISOString(),
    });
  }

  async recordProviderRequestId(id: string, requestId: string | null): Promise<void> {
    if (!requestId) return;
    await this.update(id, { provider_request_id: requestId, updated_at: new Date().toISOString() });
  }

  async markStoring(id: string): Promise<void> {
    await this.update(id, { status: 'storing', stage: 'storing' });
  }

  async markFailed(id: string, errorCode: ImageErrorCode, latencyMs: number): Promise<void> {
    const row = await this.findById(id);
    await this.update(id, {
      status: 'failed',
      error_code: errorCode,
      latency_ms: latencyMs,
      lease_owner: null,
      lease_expires_at: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    // 免费体验：免费体验次数、免费体验额度、免费体验标签
    await this.releaseFreeTrialIfNeeded(row);
  }

  async markFailedUnknown(id: string, errorCode: ImageErrorCode, latencyMs: number): Promise<void> {
    const row = await this.findById(id);
    await this.update(id, {
      status: 'failed_unknown',
      error_code: errorCode,
      latency_ms: latencyMs,
      lease_owner: null,
      lease_expires_at: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    // 免费体验：免费体验次数、免费体验额度、免费体验标签
    await this.releaseFreeTrialIfNeeded(row);
  }

  async settleReady(input: {
    attemptId: string;
    userId: string;
    amount: number;
    storagePath: string;
    imageUrl: string;
    mimeType: 'image/webp' | 'image/png' | 'image/jpeg';
    byteSize: number;
    latencyMs: number;
  }): Promise<SettlementResult> {
    const { data, error } = await this.billingDb.rpc('settle_image_generation', {
      p_attempt_id: input.attemptId,
      p_user_id: input.userId,
      p_amount: input.amount,
      p_metadata: {
        storage_path: input.storagePath,
        image_url: input.imageUrl,
        mime_type: input.mimeType,
        byte_size: input.byteSize,
        latency_ms: input.latencyMs,
      },
    });
    if (error) throw new Error(`图片生成结算失败：${error.message}`);
    return (data ?? {}) as SettlementResult;
  }

  private async findInflightByMessage(messageId: string): Promise<ChatMessageImageRow | null> {
    const { data, error } = await this.db
      .from('chat_message_images')
      .select('*')
      .eq('message_id', messageId)
      .in('status', ['pending', 'leased', 'generating', 'storing'])
      .maybeSingle();
    if (error) throw new Error(`查询图片生成中记录失败：${error.message}`);
    return (data as ChatMessageImageRow | null) ?? null;
  }

  private async readMaxAttemptNo(messageId: string): Promise<number> {
    const { data, error } = await this.db
      .from('chat_message_images')
      .select('attempt_no')
      .eq('message_id', messageId)
      .order('attempt_no', { ascending: false })
      .limit(1);
    if (error) throw new Error(`查询图片生成次数失败：${error.message}`);
    const row = (data ?? [])[0] as { attempt_no?: unknown } | undefined;
    return typeof row?.attempt_no === 'number' ? row.attempt_no : 0;
  }

  private async deleteDescriptionDrafts(input: {
    userId: string;
    sessionId: string;
    messageId: string;
    excludeId?: string;
    includeInflight: boolean;
  }): Promise<void> {
    let query = this.db
      .from('chat_message_images')
      .delete()
      .eq('user_id', input.userId)
      .eq('session_id', input.sessionId)
      .eq('message_id', input.messageId)
      .in(
        'status',
        input.includeInflight
          ? ['draft_describing', 'draft_ready', 'draft_failed']
          : ['draft_ready', 'draft_failed']
      );
    if (input.excludeId) query = query.neq('id', input.excludeId);
    const { error } = await query;
    if (error) throw new Error(`清理图片描述草稿失败：${error.message}`);
  }

  private async update(id: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await this.db.from('chat_message_images').update(patch).eq('id', id);
    if (error) throw new Error(`更新图片生成记录失败：${error.message}`);
  }

  // 免费体验：免费体验次数、免费体验额度、免费体验标签
  private async releaseFreeTrialIfNeeded(row: ChatMessageImageRow | null): Promise<void> {
    if (
      row?.image_tier !== 'basic' ||
      row.billing_mode !== 'free_trial' ||
      row.free_trial_ordinal === null
    ) {
      return;
    }
    try {
      await this.freeTrials.release({
        userId: row.user_id,
        feature: 'basic_image',
        referenceId: row.id,
      });
    } catch {
      // 释放失败不覆盖原始失败原因；过期回收 RPC 会兜底释放名额。
    }
  }
}

export function toMessageImageAttempt(row: ChatMessageImageRow): MessageImageAttempt {
  if (!row.prompt_cn || !row.prompt_source) throw new Error('图片 attempt 尚未进入可公开状态');
  return {
    id: row.id,
    message_id: row.message_id,
    attempt_no: row.attempt_no,
    tier: row.image_tier ?? 'basic',
    status: toPublicStatus(row.status),
    prompt_cn: row.prompt_cn,
    prompt_source: row.prompt_source,
    image_url: row.status === 'ready' ? row.image_url : null,
    width: row.width,
    height: row.height,
    mime_type: row.status === 'ready' ? row.mime_type : null,
    byte_size: row.status === 'ready' ? row.byte_size : null,
    error_code: row.status === 'failed' || row.status === 'failed_unknown' ? row.error_code : null,
    price_credits: toNumber(row.price_credits),
    price_label: row.price_label,
    credits_charged: toNumber(row.credits_charged),
    billing_mode: row.billing_mode ?? 'paid',
    /** 免费体验次数：1、2、3 */
    free_trial_ordinal: row.free_trial_ordinal ?? null,
    wallet_policy: row.wallet_policy ?? 'main_only',
    vip_valid_until: row.vip_valid_until ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

function toPublicStatus(status: ImageInternalStatus): MessageImageStatus {
  if (status === 'draft_describing' || status === 'draft_ready' || status === 'draft_failed') {
    throw new Error('图片描述草稿状态不得进入公开 attempt');
  }
  if (status === 'leased' || status === 'storing') return 'generating';
  return status;
}

function toNumber(value: NumericValue): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`无效数值字段：${String(value)}`);
  return parsed;
}
