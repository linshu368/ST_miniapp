// 状态面板的数据读写。存储见 migration 20261119_status_bar_v2.sql：
// 记录只经 record_chat_status / undo_chat_status 写（同锚点替换、撤销恢复在事务里保证），
// 读当前路径上的记录经 get_chat_status；玩家覆盖版直接 upsert 在用户 × 角色卡偏好表上。
// 所有调用 5 秒超时。

import { getDomainDb } from '../../lib/supabase.js';

const TIMEOUT_MS = 5_000;
const timeout = () => AbortSignal.timeout(TIMEOUT_MS);

export interface StatusSnapshotRow {
  id: string;
  text: string;
  anchorTurn: number;
  trigger: 'auto' | 'manual';
  source: 'card' | 'player' | 'auto';
  createdAt: string;
  canUndo: boolean;
}

export interface StatusPathTurn {
  historyId: string;
  turnIndex: number;
  userInput: string;
  assistantReply: string | null;
}

export interface StatusCharacterRuntime {
  name: string;
  description: string;
  /** 卡上的状态栏（作者试玩时是草稿版）；未校验的原始 JSON。 */
  statusBar: unknown;
}

export class StatusBarSessionNotFoundError extends Error {
  constructor() {
    super('STATUS_SESSION_NOT_FOUND');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

export class StatusBarRepository {
  private readonly experience = getDomainDb('experience');
  private readonly core = getDomainDb('app_core');

  async readSession(sessionId: string, userId: string): Promise<{ characterId: string } | null> {
    const { data, error } = await this.experience
      .from('chat_sessions')
      .select('character_id')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .abortSignal(timeout())
      .maybeSingle();
    if (error) throw new Error(`读取会话失败：${error.message}`, { cause: error });
    return isRecord(data) && typeof data.character_id === 'string'
      ? { characterId: data.character_id }
      : null;
  }

  async readCurrent(sessionId: string): Promise<StatusSnapshotRow | null> {
    const { data, error } = await this.experience
      .rpc('get_chat_status', { p_session_id: sessionId })
      .abortSignal(timeout());
    if (error) throw new Error(`读取状态失败：${error.message}`, { cause: error });
    const row: unknown = Array.isArray(data) ? data[0] : data;
    if (!isRecord(row) || typeof row.snapshot_id !== 'string') return null;
    return {
      id: row.snapshot_id,
      text: text(row.status_text),
      anchorTurn: typeof row.anchor_turn_index === 'number' ? row.anchor_turn_index : 0,
      trigger: row.trigger === 'manual' ? 'manual' : 'auto',
      source:
        row.template_source === 'player' || row.template_source === 'auto'
          ? row.template_source
          : 'card',
      createdAt: text(row.created_at),
      canUndo: row.can_undo === true,
    };
  }

  async record(input: {
    sessionId: string;
    userId: string;
    anchor: StatusPathTurn;
    text: string;
    source: 'card' | 'player' | 'auto';
    trigger: 'auto' | 'manual';
  }): Promise<string> {
    const { data, error } = await this.experience
      .rpc('record_chat_status', {
        p_session_id: input.sessionId,
        p_user_id: input.userId,
        p_anchor_history_id: input.anchor.historyId,
        p_anchor_turn_index: input.anchor.turnIndex,
        p_status_text: input.text,
        p_template_source: input.source,
        p_trigger: input.trigger,
      })
      .abortSignal(timeout());
    if (error) {
      if (error.code === 'P0002') throw new StatusBarSessionNotFoundError();
      throw new Error(`保存状态失败：${error.message}`, { cause: error });
    }
    return String(data);
  }

  async undo(sessionId: string, userId: string): Promise<boolean> {
    const { data, error } = await this.experience
      .rpc('undo_chat_status', { p_session_id: sessionId, p_user_id: userId })
      .abortSignal(timeout());
    if (error) {
      if (error.code === 'P0002') throw new StatusBarSessionNotFoundError();
      throw new Error(`撤销状态失败：${error.message}`, { cause: error });
    }
    return data === true;
  }

  /** 当前路径上最近几轮（含分支继承轮次），按轮次升序。 */
  async readRecentTurns(sessionId: string, limit: number): Promise<StatusPathTurn[]> {
    const { data, error } = await this.experience
      .from('session_chat_history')
      .select('id,turn_index,user_input,assistant_reply')
      .eq('session_id', sessionId)
      .order('turn_index', { ascending: false })
      .limit(limit)
      .abortSignal(timeout());
    if (error) throw new Error(`读取近期轮次失败：${error.message}`, { cause: error });
    return toTurns(data).reverse();
  }

  /** 更早轮次只取玩家输入（按轮次降序取 limit 条，返回升序）。 */
  async readEarlierUserInputs(
    sessionId: string,
    beforeTurn: number,
    limit: number
  ): Promise<StatusPathTurn[]> {
    if (beforeTurn <= 1) return [];
    const { data, error } = await this.experience
      .from('session_chat_history')
      .select('id,turn_index,user_input')
      .eq('session_id', sessionId)
      .lt('turn_index', beforeTurn)
      .order('turn_index', { ascending: false })
      .limit(limit)
      .abortSignal(timeout());
    if (error) throw new Error(`读取更早轮次失败：${error.message}`, { cause: error });
    return toTurns(data).reverse();
  }

  /** 会话绑定的卡内容（含状态栏）；没有会话时读卡的当前内容。 */
  async readCharacterRuntime(
    characterId: string,
    userId: string,
    sessionId?: string
  ): Promise<StatusCharacterRuntime> {
    const { data, error } = await this.core
      .rpc(sessionId ? 'read_session_character_runtime' : 'read_character_runtime', {
        p_character_id: characterId,
        p_user_id: userId,
        ...(sessionId ? { p_session_id: sessionId } : {}),
        p_opening_only: false,
      })
      .abortSignal(timeout());
    if (error) throw new Error(`读取角色内容失败：${error.message}`, { cause: error });
    const row = isRecord(data) ? data : {};
    const statusBar = row.status_bar ?? null;
    // 会话绑定的创作卡版本快照不可变：状态栏上线前发布的版本里没有状态栏，
    // 回落到卡上现在这份（运营给存量卡批量生成的就写在卡上）。
    if (sessionId && statusBar === null) {
      const card = await this.readCharacterRuntime(characterId, userId);
      return {
        name: text(row.name),
        description: text(row.description),
        statusBar: card.statusBar,
      };
    }
    return { name: text(row.name), description: text(row.description), statusBar };
  }

  async readOverride(userId: string, characterId: string): Promise<unknown> {
    const { data, error } = await this.core
      .from('user_character_preferences')
      .select('status_bar_detail')
      .eq('user_id', userId)
      .eq('character_id', characterId)
      .abortSignal(timeout())
      .maybeSingle();
    if (error) throw new Error(`读取玩家状态栏失败：${error.message}`, { cause: error });
    return isRecord(data) ? (data.status_bar_detail ?? null) : null;
  }

  /** null 表示恢复作者的版本。只写这一列，不动补充设定和人设选择。 */
  async writeOverride(userId: string, characterId: string, template: unknown): Promise<void> {
    const { error } = await this.core
      .from('user_character_preferences')
      .upsert(
        { user_id: userId, character_id: characterId, status_bar_detail: template },
        { onConflict: 'user_id,character_id' }
      )
      .abortSignal(timeout());
    if (error) throw new Error(`保存玩家状态栏失败：${error.message}`, { cause: error });
  }
}

function toTurns(data: unknown): StatusPathTurn[] {
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
