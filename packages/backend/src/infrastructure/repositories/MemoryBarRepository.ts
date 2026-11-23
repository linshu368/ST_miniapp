// 记忆栏的数据读写。存储见 migration 20261123_memory_panel.sql：
// 记录只经 record_chat_memory 写（写前比对读到的那条仍是当前最新，同锚点覆盖），
// 读当前路径上的记录经 get_chat_memory；玩家的记忆要求直接写在用户 × 角色卡偏好表的一列上。
// 所有调用 5 秒超时。

import { MemoryBarStateSchema, type MemoryBarState } from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';

const TIMEOUT_MS = 5_000;
const timeout = () => AbortSignal.timeout(TIMEOUT_MS);

export interface MemorySnapshotRow {
  id: string;
  /** 库里的快照认不出（版本或上限变了）时为 null，按没有记忆处理 */
  state: MemoryBarState | null;
  anchorTurn: number;
  trigger: 'auto' | 'manual';
  createdAt: string;
}

export interface MemoryPathTurn {
  historyId: string;
  turnIndex: number;
  userInput: string;
  assistantReply: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

function toTurns(data: unknown): MemoryPathTurn[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row: unknown) => {
    if (!isRecord(row) || typeof row.turn_index !== 'number' || typeof row.id !== 'string')
      return [];
    return [
      {
        historyId: row.id,
        turnIndex: row.turn_index,
        userInput: text(row.user_input),
        assistantReply: typeof row.assistant_reply === 'string' ? row.assistant_reply : null,
      },
    ];
  });
}

export class MemoryBarRepository {
  private readonly experience = getDomainDb('experience');
  private readonly core = getDomainDb('app_core');

  async readCurrent(sessionId: string): Promise<MemorySnapshotRow | null> {
    const { data, error } = await this.experience
      .rpc('get_chat_memory', { p_session_id: sessionId })
      .abortSignal(timeout());
    if (error) throw new Error(`读取记忆失败：${error.message}`, { cause: error });
    const row: unknown = Array.isArray(data) ? data[0] : data;
    if (!isRecord(row) || typeof row.snapshot_id !== 'string') return null;
    const parsed = MemoryBarStateSchema.safeParse(row.memory_snapshot);
    return {
      id: row.snapshot_id,
      state: parsed.success ? parsed.data : null,
      anchorTurn: typeof row.anchor_turn_index === 'number' ? row.anchor_turn_index : 0,
      trigger: row.trigger === 'manual' ? 'manual' : 'auto',
      createdAt: text(row.created_at),
    };
  }

  /** 返回 null：读到的那条已不是当前最新（别的检查先写了），本次放弃。 */
  async record(input: {
    sessionId: string;
    userId: string;
    anchor: { historyId: string; turnIndex: number };
    state: MemoryBarState;
    chars: number;
    trigger: 'auto' | 'manual';
    promptVersion: number;
    expectedPreviousId: string | null;
  }): Promise<string | null> {
    const { data, error } = await this.experience
      .rpc('record_chat_memory', {
        p_session_id: input.sessionId,
        p_user_id: input.userId,
        p_anchor_history_id: input.anchor.historyId,
        p_anchor_turn_index: input.anchor.turnIndex,
        p_memory_snapshot: input.state,
        p_memory_chars: input.chars,
        p_trigger: input.trigger,
        p_prompt_version: input.promptVersion,
        p_expected_previous_id: input.expectedPreviousId,
      })
      .abortSignal(timeout());
    if (error) throw new Error(`保存记忆失败：${error.message}`, { cause: error });
    return typeof data === 'string' ? data : null;
  }

  /** 当前路径上 [fromTurn, toTurn] 的轮次（含分支继承轮次），按轮次升序，最多 limit 条（取最近的）。 */
  async readTurns(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    limit: number
  ): Promise<MemoryPathTurn[]> {
    const { data, error } = await this.experience
      .from('session_chat_history')
      .select('id,turn_index,user_input,assistant_reply')
      .eq('session_id', sessionId)
      .gte('turn_index', Math.max(1, fromTurn))
      .lte('turn_index', toTurn)
      .order('turn_index', { ascending: false })
      .limit(limit)
      .abortSignal(timeout());
    if (error) throw new Error(`读取轮次失败：${error.message}`, { cause: error });
    return toTurns(data).reverse();
  }

  /** 老会话：当前路径上最近一条带旧记忆区的回复（只在还没有任何新记忆时读一次）。 */
  async readLatestLegacyMemoryTurn(sessionId: string): Promise<MemoryPathTurn | null> {
    const { data, error } = await this.experience
      .from('session_chat_history')
      .select('id,turn_index,user_input,assistant_reply')
      .eq('session_id', sessionId)
      .ilike('assistant_reply', '%[memory]%')
      .order('turn_index', { ascending: false })
      .limit(1)
      .abortSignal(timeout());
    if (error) throw new Error(`读取旧记忆区失败：${error.message}`, { cause: error });
    return toTurns(data)[0] ?? null;
  }

  async readRequest(userId: string, characterId: string): Promise<string | null> {
    const { data, error } = await this.core
      .from('user_character_preferences')
      .select('memory_request')
      .eq('user_id', userId)
      .eq('character_id', characterId)
      .abortSignal(timeout())
      .maybeSingle();
    if (error) throw new Error(`读取记忆要求失败：${error.message}`, { cause: error });
    return isRecord(data) && typeof data.memory_request === 'string' ? data.memory_request : null;
  }

  /** null 表示清空。只写这一列，不动补充设定、人设选择和玩家状态栏。 */
  async writeRequest(userId: string, characterId: string, request: string | null): Promise<void> {
    const { error } = await this.core
      .from('user_character_preferences')
      .upsert(
        { user_id: userId, character_id: characterId, memory_request: request },
        { onConflict: 'user_id,character_id' }
      )
      .abortSignal(timeout());
    if (error) throw new Error(`保存记忆要求失败：${error.message}`, { cause: error });
  }

  async readShowMemory(userId: string): Promise<boolean> {
    const { data, error } = await this.core
      .from('user_preferences')
      .select('pref_show_memory')
      .eq('user_id', userId)
      .abortSignal(timeout())
      .maybeSingle();
    if (error) throw new Error(`读取记忆栏开关失败：${error.message}`, { cause: error });
    // 没有偏好行 = 全部默认（记忆栏默认开）
    return isRecord(data) && typeof data.pref_show_memory === 'boolean'
      ? data.pref_show_memory
      : true;
  }
}
