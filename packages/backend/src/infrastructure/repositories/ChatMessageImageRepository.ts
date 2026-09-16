import type {
  ImageErrorCode,
  ImagePromptSource,
  MessageImageAttempt,
  MessageImageState,
  MessageImageStatus,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';

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
  prompt_cn: string;
  prompt_source: ImagePromptSource;
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
  | 'pending'
  | 'leased'
  | 'generating'
  | 'storing'
  | 'ready'
  | 'failed'
  | 'failed_unknown';

interface SettlementResult {
  charge_status?: 'charged' | 'already_charged' | 'insufficient_balance';
  ledger_id?: string | null;
  required?: NumericValue;
  available?: NumericValue;
}

export class ChatMessageImageRepository {
  private readonly db = getDomainDb('experience');
  private readonly billingDb = getDomainDb('billing');

  async listBySession(sessionId: string): Promise<MessageImageState[]> {
    const { data, error } = await this.db
      .from('chat_message_images')
      .select('*')
      .eq('session_id', sessionId)
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
    userId: string;
    sessionId: string;
    messageId: string;
    promptCn: string;
    promptSource: ImagePromptSource;
    model: string;
    baseUrlHost: string | null;
    width: number;
    height: number;
    priceCredits: number;
    priceLabel: string;
  }): Promise<ChatMessageImageRow> {
    const inflight = await this.findInflightByMessage(input.messageId);
    if (inflight) throw new ImageConflictError();

    const attemptNo = (await this.readMaxAttemptNo(input.messageId)) + 1;
    const { data, error } = await this.db
      .from('chat_message_images')
      .insert({
        user_id: input.userId,
        session_id: input.sessionId,
        message_id: input.messageId,
        attempt_no: attemptNo,
        prompt_cn: input.promptCn,
        prompt_source: input.promptSource,
        provider: 'liaobots_grok',
        model: input.model,
        base_url_host: input.baseUrlHost,
        width: input.width,
        height: input.height,
        output_format: 'webp',
        price_credits: input.priceCredits,
        price_label: input.priceLabel,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') throw new ImageConflictError();
      throw new Error(`创建图片生成记录失败：${error.message}`);
    }
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
    await this.update(id, {
      status: 'failed',
      error_code: errorCode,
      latency_ms: latencyMs,
      lease_owner: null,
      lease_expires_at: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  async markFailedUnknown(id: string, errorCode: ImageErrorCode, latencyMs: number): Promise<void> {
    await this.update(id, {
      status: 'failed_unknown',
      error_code: errorCode,
      latency_ms: latencyMs,
      lease_owner: null,
      lease_expires_at: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
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

  private async update(id: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await this.db.from('chat_message_images').update(patch).eq('id', id);
    if (error) throw new Error(`更新图片生成记录失败：${error.message}`);
  }
}

export function toMessageImageAttempt(row: ChatMessageImageRow): MessageImageAttempt {
  return {
    id: row.id,
    message_id: row.message_id,
    attempt_no: row.attempt_no,
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
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

function toPublicStatus(status: ImageInternalStatus): MessageImageStatus {
  if (status === 'leased' || status === 'storing') return 'generating';
  return status;
}

function toNumber(value: NumericValue): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`无效数值字段：${String(value)}`);
  return parsed;
}
