// 角色回复语音的仓库层（migration 080）。
//
// message_id 指向 experience.chat_history.id，即 toChatMessages 给 assistant 消息的 id。
// 表是追加写的：重新生成插新行，成功才把旧行 is_active 置否，既保留「当前语音」也保留用量流水。
//
// 失败不让位（需求 Q3，migration 102 起）：重新生成时旧 ready 行保持 is_active=true，
// 新 pending 行 is_active=false。失败后旧 ready 仍是唯一生效行，前端继续能播；
// 本次失败码通过 resolveMessageVoice 组合进 last_error_code，在播放条下方提示。
// 并发保护由 uq_chat_message_audio_pending（message_id where status='pending'）接手：
// pending 行不再一定是 active，原 uq_chat_message_audio_active 拦不住连点。

import type { MessageVoice, MessageVoiceStatus } from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import { config } from '../../platform/config.js';

/** 最坏情况下串行发起的上游请求数：写稿两闸各一次，合成一次 */
const MAX_UPSTREAM_CALLS = 3;

/**
 * pending 超过这个时长即视为失败。
 *
 * 生成是接完请求后在进程内异步跑的，部署重启会让在途的那几条永远停在 pending。
 * 没有这条超时，用户会看到一个永远转圈、还点不了重试的按钮。
 *
 * 阈值必须大于最坏耗时，否则会把还在正常重试的记录判成失败，用户点重试反而
 * 撞上一个仍在跑的任务。所以跟着上游超时配置走，不写死——写稿加了兜底闸之后，
 * 原来那个 5 分钟的常量已经短于最坏耗时了。多留一分钟给对象存储上传和收口写库。
 */
const PENDING_STALE_MS = config.voice.timeoutMs * MAX_UPSTREAM_CALLS + 60_000;

export type AudioConflictReason = 'already_generating';

export class AudioConflictError extends Error {
  constructor(readonly reason: AudioConflictReason) {
    super('这条回复正在生成语音');
    this.name = 'AudioConflictError';
  }
}

export interface ChatMessageAudioRow {
  id: string;
  message_id: string;
  session_id: string;
  user_id: string;
  revision: number;
  is_active: boolean;
  status: MessageVoiceStatus;
  voice_id: string;
  tts_model: string;
  tts_speed: number;
  source_chars: number;
  spoken_chars: number;
  spoken_text: string | null;
  storage_path: string | null;
  audio_url: string | null;
  duration_ms: number | null;
  latency_ms: number | null;
  error_code: string | null;
  /** 本次生成实扣星尘：成功为计费额度，失败/未扣费为 0 */
  credits_charged: number;
  /** 扣费幂等键，一般等于本行 id；NULL 表示未扣费 */
  charge_id: string | null;
  created_at: string;
  updated_at: string;
}

export class ChatMessageAudioRepository {
  private readonly db = getDomainDb('experience');

  /**
   * 会话内全部语音（按消息聚合后呈现）。ownership 由调用方在校验会话归属时保证。
   *
   * 读路径要取该会话全部行（含 inactive 的 pending / failed），才能在已有可播时
   * 把本次失败码组合进 last_error_code。索引走 102 的 idx_chat_message_audio_session_all。
   */
  async listBySession(sessionId: string): Promise<MessageVoice[]> {
    const { data, error } = await this.db
      .from('chat_message_audio')
      .select('*')
      .eq('session_id', sessionId);

    if (error) throw new Error(`查询会话语音失败：${error.message}`);

    const byMessage = new Map<string, ChatMessageAudioRow[]>();
    for (const row of (data ?? []) as ChatMessageAudioRow[]) {
      const list = byMessage.get(row.message_id);
      if (list) list.push(row);
      else byMessage.set(row.message_id, [row]);
    }

    const voices: MessageVoice[] = [];
    for (const rows of byMessage.values()) {
      const resolved = resolveMessageVoice(rows);
      if (resolved) voices.push(resolved);
    }
    return voices;
  }

  async findActiveByMessage(messageId: string): Promise<ChatMessageAudioRow | null> {
    const { data, error } = await this.db
      .from('chat_message_audio')
      .select('*')
      .eq('message_id', messageId)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw new Error(`查询消息语音失败：${error.message}`);
    return (data as ChatMessageAudioRow | null) ?? null;
  }

  /**
   * 查一条消息当前的 pending 行（无论是否 active）。
   *
   * 102 起 pending 行不一定是 active（重新生成时旧 ready 仍 active、新 pending inactive），
   * 判重必须按 status 而不是 is_active。uq_chat_message_audio_pending 保证至多一行。
   */
  async findPendingByMessage(messageId: string): Promise<ChatMessageAudioRow | null> {
    const { data, error } = await this.db
      .from('chat_message_audio')
      .select('*')
      .eq('message_id', messageId)
      .eq('status', 'pending')
      .maybeSingle();

    if (error) throw new Error(`查询消息生成中语音失败：${error.message}`);
    return (data as ChatMessageAudioRow | null) ?? null;
  }

  async findById(id: string): Promise<ChatMessageAudioRow | null> {
    const { data, error } = await this.db
      .from('chat_message_audio')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw new Error(`查询语音记录失败：${error.message}`);
    return (data as ChatMessageAudioRow | null) ?? null;
  }

  /**
   * 受理一次生成：插入一行 pending。
   *
   * 失败不让位（Q3）：
   *   - 旧生效行是 ready：保持 is_active=true，新 pending is_active=false。
   *     失败后旧 ready 仍是唯一生效行，前端继续能播；本次失败码组合进 last_error_code。
   *   - 旧生效行是 failed 或没有生效行（首次 / 无旧音频可保）：让位后插入 is_active=true 的 pending，
   *     失败时仍是 active failed，入口变「重试」。
   *
   * 并发保护交给 uq_chat_message_audio_pending（message_id where status='pending'）：
   * pending 行不再一定是 active，原 active 唯一索引拦不住连点。撞 23505 翻译成 already_generating。
   * 卡死的 pending 先回写成 failed，腾出 pending 唯一索引槽位再插入。
   */
  async createPending(input: {
    messageId: string;
    sessionId: string;
    userId: string;
    voiceId: string;
    ttsModel: string;
    ttsSpeed: number;
    sourceChars: number;
  }): Promise<ChatMessageAudioRow> {
    const pending = await this.findPendingByMessage(input.messageId);
    if (pending && !isStalePending(pending)) {
      throw new AudioConflictError('already_generating');
    }
    if (pending) {
      // 卡死的 pending 回写成 failed，腾出 uq_chat_message_audio_pending 槽位
      await this.markFailed(pending.id, 'voice_generation_stalled', 0);
    }

    const existing = await this.findActiveByMessage(input.messageId);
    const nextRevision = Math.max(existing?.revision ?? -1, pending?.revision ?? -1) + 1;

    // 旧 ready 不让位：失败时用户不能丢掉上一版可播音频
    const keepOldReadyActive = existing?.status === 'ready';
    if (existing && !keepOldReadyActive) {
      const { error } = await this.db
        .from('chat_message_audio')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) throw new Error(`让位旧语音失败：${error.message}`);
    }

    const { data, error } = await this.db
      .from('chat_message_audio')
      .insert({
        message_id: input.messageId,
        session_id: input.sessionId,
        user_id: input.userId,
        revision: nextRevision,
        status: 'pending',
        is_active: !keepOldReadyActive,
        voice_id: input.voiceId,
        tts_model: input.ttsModel,
        tts_speed: input.ttsSpeed,
        source_chars: input.sourceChars,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') throw new AudioConflictError('already_generating');
      throw new Error(`创建语音生成记录失败：${error.message}`);
    }
    return data as ChatMessageAudioRow;
  }

  /**
   * 写稿一出来就落库，别等合成成功。
   *
   * 合成失败时这一行是唯一能回答「到底送了什么进 TTS」的地方。
   * 上游的内容审核拒绝只回一个错误码，没有这份台词就无从判断是审核误伤还是写稿写飞了。
   */
  async saveDraft(id: string, spokenText: string): Promise<void> {
    const { error } = await this.db
      .from('chat_message_audio')
      .update({
        spoken_text: spokenText,
        spoken_chars: spokenText.length,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) throw new Error(`保存语音台词失败：${error.message}`);
  }

  /**
   * 成功才让位：先把同消息当前生效行（旧 ready）置 inactive，再把本行标 ready + active。
   *
   * 顺序与「先让位再插入」一致：旧 ready 在本行就绪前仍可播，窗口可接受。
   * 首次生成时本行就是 active pending，跳过让位直接转 ready。
   */
  async markReady(
    id: string,
    input: {
      spokenText: string;
      storagePath: string;
      audioUrl: string;
      durationMs: number | null;
      latencyMs: number;
      /** 本次实扣星尘（成功为计费额度，失败/未扣费为 0） */
      creditsCharged: number;
      /** 扣费幂等键，未扣费传 null */
      chargeId: string | null;
    }
  ): Promise<void> {
    const row = await this.findById(id);
    if (!row) throw new Error(`语音记录不存在：${id}`);

    if (row.is_active !== true) {
      // 重新生成成功：把旧 ready 让位，再让本行接管生效
      const active = await this.findActiveByMessage(row.message_id);
      if (active && active.id !== id) {
        const { error: deactivateError } = await this.db
          .from('chat_message_audio')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('id', active.id);
        if (deactivateError) throw new Error(`让位旧语音失败：${deactivateError.message}`);
      }
      const { error: activateError } = await this.db
        .from('chat_message_audio')
        .update({ is_active: true, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (activateError) throw new Error(`激活新语音失败：${activateError.message}`);
    }

    const { error } = await this.db
      .from('chat_message_audio')
      .update({
        status: 'ready',
        spoken_text: input.spokenText,
        spoken_chars: input.spokenText.length,
        storage_path: input.storagePath,
        audio_url: input.audioUrl,
        duration_ms: input.durationMs,
        latency_ms: input.latencyMs,
        error_code: null,
        credits_charged: input.creditsCharged,
        charge_id: input.chargeId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) throw new Error(`更新语音生成结果失败：${error.message}`);
  }

  /**
   * 失败只标失败，不动 is_active：
   *   - 首次生成的 pending 本就是 active，失败后保持 active，入口变「重试」。
   *   - 重新生成的 pending 是 inactive（旧 ready 仍 active），失败后保持 inactive，
   *     旧 ready 仍是唯一生效行，前端继续能播；本次失败码经 resolveMessageVoice 组合进 last_error_code。
   */
  async markFailed(id: string, errorCode: string, latencyMs: number): Promise<void> {
    const { error } = await this.db
      .from('chat_message_audio')
      .update({
        status: 'failed',
        error_code: errorCode,
        latency_ms: latencyMs,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) throw new Error(`标记语音生成失败失败：${error.message}`);
  }
}

function isStalePending(row: ChatMessageAudioRow): boolean {
  return Date.now() - new Date(row.created_at).getTime() > PENDING_STALE_MS;
}

/**
 * 卡死的 pending 对外按 failed 呈现，让用户能重试。
 * 不在读路径回写数据库：读接口会被轮询打到，顺手写库既放大了写量，
 * 也会让「什么时候变成 failed」取决于谁先读到，排查时对不上。
 *
 * 单行映射不带 last_error_code（单行没有「上一版可播 + 本次失败」的组合语义），
 * 组合由 resolveMessageVoice 在会话级聚合时补上。
 */
export function toMessageVoice(row: ChatMessageAudioRow): MessageVoice {
  const stale = row.status === 'pending' && isStalePending(row);
  return {
    message_id: row.message_id,
    status: stale ? 'failed' : row.status,
    audio_url: row.status === 'ready' ? row.audio_url : null,
    duration_ms: row.status === 'ready' ? row.duration_ms : null,
    // 只在成片可播时给台词：pending 行里的台词是半成品，failed 行里的那份没被念出来，
    // 摆在播放条下面会让用户以为听到的就是这段字
    spoken_text: row.status === 'ready' ? row.spoken_text : null,
    voice_id: row.voice_id,
    error_code: stale ? 'voice_generation_stalled' : row.error_code,
    last_error_code: null,
    credits_charged: row.credits_charged ?? 0,
    created_at: row.created_at,
  };
}

/**
 * 把同一条消息的全部 audio 行聚合成对外的一份语音状态。
 *
 * 规则（Q3 失败不让位）：
 *   1. 存在未过期 pending → 生成中（status=pending），隐藏播放条。
 *   2. 否则取生效行（is_active）：
 *      - ready：找比它更新且失败的尝试（含卡死 pending 视为 stalled），
 *        把失败码写进 last_error_code，播放条仍可播。
 *      - failed：首次生成失败，无上一版可播，入口变「重试」。
 *      - 卡死 pending：toMessageVoice 已映射为 failed。
 *   3. 没有生效行（防御）：取最大 revision 行兜底。
 *
 * 导出供单测直接覆盖，不连库。
 */
export function resolveMessageVoice(rows: ChatMessageAudioRow[]): MessageVoice | null {
  if (rows.length === 0) return null;

  const livePending = rows.find((r) => r.status === 'pending' && !isStalePending(r));
  if (livePending) return toMessageVoice(livePending);

  const active = rows.find((r) => r.is_active);
  const base = active ?? rows.reduce((a, b) => (b.revision > a.revision ? b : a));
  const voice = toMessageVoice(base);

  if (voice.status !== 'ready') return voice;

  // 已有可播：找比当前 ready 更新一次的失败尝试（含卡死 pending）作为 last_error_code
  const newerFailure = rows
    .filter((r) => r !== active && r.revision > base.revision)
    .map((r) => ({
      row: r,
      code:
        r.status === 'pending' && isStalePending(r)
          ? 'voice_generation_stalled'
          : r.status === 'failed'
            ? r.error_code
            : null,
    }))
    .filter((x) => x.code !== null)
    .sort((a, b) => b.row.revision - a.row.revision)[0];

  if (newerFailure) {
    return { ...voice, last_error_code: newerFailure.code };
  }
  return voice;
}
