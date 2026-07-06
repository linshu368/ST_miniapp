/**
 * backend / lib / chat-history-logger.ts
 *
 * 异步写入 miniapp.chat_history_log，记录每轮 LLM 交互。
 * 所有写入均为 fire-and-forget，失败仅 log 不影响用户请求。
 */

import type { FastifyBaseLogger } from 'fastify';
import { getSupabaseClient } from './supabase.js';

export interface ChatHistoryEntry {
  user_id: string;
  model: string;
  user_input: string;
  assistant_reply: string | null;
  history: unknown[];
  character_id?: string | null;
  preset_id?: string | null;
  status: 'success' | 'upstream_error' | 'stream_interrupted';
  upstream_status?: number | null;
  deduction_rate: number;
}

export function saveChatHistory(entry: ChatHistoryEntry, log: FastifyBaseLogger): void {
  void (async () => {
    try {
      const supabase = getSupabaseClient();
      const miniappDb = supabase.schema('miniapp' as 'public');
      const { error } = await miniappDb.from('chat_history').insert({
        user_id: entry.user_id,
        model: entry.model,
        user_input: entry.user_input,
        assistant_reply: entry.assistant_reply,
        history: entry.history,
        character_id: entry.character_id ?? null,
        preset_id: entry.preset_id ?? null,
        status: entry.status,
        upstream_status: entry.upstream_status ?? null,
        deduction_rate: entry.deduction_rate,
      });

      if (error) {
        log.error(
          { err: error.message, userId: entry.user_id, model: entry.model },
          '[chat-history] insert failed'
        );
      } else {
        log.info({ userId: entry.user_id, model: entry.model }, '[chat-history] saved');
        if (entry.status === 'success') {
          const { error: roundErr } = await miniappDb.rpc('increment_user_total_round', {
            p_user_id: entry.user_id,
            p_delta: 1,
          });
          if (roundErr) {
            log.error(
              { err: roundErr.message, userId: entry.user_id },
              '[chat-history] increment total_round failed'
            );
          }
        }
      }
    } catch (err: unknown) {
      log.error({ err: String(err), userId: entry.user_id }, '[chat-history] unexpected error');
    }
  })();
}
