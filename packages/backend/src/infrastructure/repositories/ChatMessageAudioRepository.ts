// 角色回复语音的仓库层（migration 080）。
//
// message_id 指向 miniapp.chat_history.id，即 toChatMessages 给 assistant 消息的 id。
// 表是追加写的：重新生成插新行、把旧行 is_active 置否，既保留「当前语音」也保留用量流水。

import type { MessageVoice, MessageVoiceStatus } from '@miniapp/shared';
import { getSupabaseClient } from '../../lib/supabase.js';

/**
 * pending 超过这个时长即视为失败。
 *
 * 生成是接完请求后在进程内异步跑的，部署重启会让在途的那几条永远停在 pending。
 * 没有这条超时，用户会看到一个永远转圈、还点不了重试的按钮。
 * 取 5 分钟：上游单次调用超时 120s，两段加起来最坏 4 分钟出头。
 */
const PENDING_STALE_MS = 5 * 60 * 1000;

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
  created_at: string;
  updated_at: string;
}

export class ChatMessageAudioRepository {
  private readonly db = getSupabaseClient().schema('miniapp');

  /** 会话内全部生效语音。ownership 由调用方在校验会话归属时保证 */
  async listBySession(sessionId: string): Promise<MessageVoice[]> {
    const { data, error } = await this.db
      .from('chat_message_audio')
      .select('*')
      .eq('session_id', sessionId)
      .eq('is_active', true);

    if (error) throw new Error(`查询会话语音失败：${error.message}`);
    return ((data ?? []) as ChatMessageAudioRow[]).map(toMessageVoice);
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
   * 受理一次生成：把旧的生效行让位，插入一行 pending。
   *
   * 并发保护交给 uq_chat_message_audio_active（message_id where is_active）：
   * 用户连点两下时两个请求会同时走到这里，先读后写在这种情况下必然漏判，
   * 唯一索引才是真正拦得住的那一道。撞上就翻译成 already_generating。
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
    const existing = await this.findActiveByMessage(input.messageId);
    if (existing && existing.status === 'pending' && !isStalePending(existing)) {
      throw new AudioConflictError('already_generating');
    }

    if (existing) {
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
        revision: existing ? existing.revision + 1 : 0,
        status: 'pending',
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

  async markReady(
    id: string,
    input: {
      spokenText: string;
      storagePath: string;
      audioUrl: string;
      durationMs: number | null;
      latencyMs: number;
    }
  ): Promise<void> {
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
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) throw new Error(`更新语音生成结果失败：${error.message}`);
  }

  /**
   * 失败行保留且保持 is_active：前端要靠它把按钮显示成「重试」。
   * 下次生成时 createPending 会把它让位掉。
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
 */
export function toMessageVoice(row: ChatMessageAudioRow): MessageVoice {
  const stale = row.status === 'pending' && isStalePending(row);
  return {
    message_id: row.message_id,
    status: stale ? 'failed' : row.status,
    audio_url: row.status === 'ready' ? row.audio_url : null,
    duration_ms: row.status === 'ready' ? row.duration_ms : null,
    voice_id: row.voice_id,
    error_code: stale ? 'voice_generation_stalled' : row.error_code,
    created_at: row.created_at,
  };
}
