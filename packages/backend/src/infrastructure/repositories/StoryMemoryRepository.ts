/**
 * 会话长期记忆的读写。写入只走 20261110_story_memory.sql 的受限 RPC。
 */
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';
import type { StoryTurn } from '../../features/story-memory/text.js';

const RPC_TIMEOUT_MS = 5_000;

export interface LatestStoryMemory {
  version: number;
  content: string;
  coveredEndTurn: number;
}

export interface ClaimedStoryMemoryJob {
  sessionId: string;
  userId: string;
  characterId: string;
  windowStart: number;
  /** 请求压缩到的轮次（含），可超前于窗口起点 */
  targetEnd: number;
  attempts: number;
  coveredEndTurn: number;
  memoryContent: string | null;
}

export interface FinishedStoryMemoryJob {
  status: string;
  attempts: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toClaimedJob(value: unknown): ClaimedStoryMemoryJob | null {
  if (!isRecord(value)) return null;
  const {
    session_id,
    user_id,
    character_id,
    window_start,
    target_end,
    attempts,
    covered_end_turn,
  } = value;
  if (
    typeof session_id !== 'string' ||
    typeof user_id !== 'string' ||
    typeof character_id !== 'string' ||
    typeof window_start !== 'number' ||
    typeof target_end !== 'number' ||
    typeof attempts !== 'number' ||
    typeof covered_end_turn !== 'number'
  ) {
    return null;
  }
  return {
    sessionId: session_id,
    userId: user_id,
    characterId: character_id,
    windowStart: window_start,
    targetEnd: target_end,
    attempts,
    coveredEndTurn: covered_end_turn,
    memoryContent: typeof value.memory_content === 'string' ? value.memory_content : null,
  };
}

export class StoryMemoryRepository {
  constructor(private readonly db: DomainDb = getDomainDb('experience')) {}

  async readLatest(sessionId: string, signal: AbortSignal): Promise<LatestStoryMemory | null> {
    const { data, error } = await this.db
      .from('story_memories')
      .select('version,content,covered_end_turn')
      .eq('session_id', sessionId)
      .order('version', { ascending: false })
      .limit(1)
      .abortSignal(signal)
      .maybeSingle();
    if (error) throw new Error(`读取会话记忆失败：${error.message}`);
    const row = data as { version?: unknown; content?: unknown; covered_end_turn?: unknown } | null;
    if (
      !row ||
      typeof row.version !== 'number' ||
      typeof row.content !== 'string' ||
      typeof row.covered_end_turn !== 'number'
    ) {
      return null;
    }
    return { version: row.version, content: row.content, coveredEndTurn: row.covered_end_turn };
  }

  /**
   * 起点 CAS 前移（toStart = fromStart 时不移动），并在同一事务里把压缩目标提高到 targetEnd。
   * 返回 false 表示起点已被别处移动或会话已删除。
   */
  async advanceWindow(
    sessionId: string,
    fromStart: number,
    toStart: number,
    targetEnd: number
  ): Promise<boolean> {
    const { data, error } = await this.db
      .rpc('advance_story_memory_window', {
        p_session_id: sessionId,
        p_from_start: fromStart,
        p_to_start: toStart,
        p_target_end: targetEnd,
      })
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
    if (error) throw new Error(`前移上下文窗口失败：${error.message}`);
    return data === true;
  }

  async claimJobs(
    workerId: string,
    limit: number,
    leaseSeconds: number
  ): Promise<ClaimedStoryMemoryJob[]> {
    const { data, error } = await this.db
      .rpc('claim_story_memory_jobs', {
        p_worker: workerId,
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      })
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
    if (error) throw new Error(`领取记忆任务失败：${error.message}`);
    if (!Array.isArray(data)) return [];
    return data.map(toClaimedJob).filter((job): job is ClaimedStoryMemoryJob => job !== null);
  }

  async commitVersion(input: {
    sessionId: string;
    workerId: string;
    expectedCoveredEnd: number;
    coveredEnd: number;
    content: string;
    promptVersion: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    leaseSeconds: number;
  }): Promise<number> {
    const { data, error } = await this.db
      .rpc('commit_story_memory_version', {
        p_session_id: input.sessionId,
        p_worker: input.workerId,
        p_expected_covered_end: input.expectedCoveredEnd,
        p_covered_end: input.coveredEnd,
        p_content: input.content,
        p_prompt_version: input.promptVersion,
        p_model: input.model,
        p_input_tokens: input.inputTokens,
        p_output_tokens: input.outputTokens,
        p_lease_seconds: input.leaseSeconds,
      })
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
    if (error) throw new Error(`提交会话记忆失败：${error.message}`);
    if (typeof data !== 'number') throw new Error('提交会话记忆结果字段不完整');
    return data;
  }

  async finishJob(input: {
    sessionId: string;
    workerId: string;
    errorCode: string | null;
    rangeStart: number | null;
    rangeEnd: number | null;
  }): Promise<FinishedStoryMemoryJob> {
    const { data, error } = await this.db
      .rpc('finish_story_memory_job', {
        p_session_id: input.sessionId,
        p_worker: input.workerId,
        p_error_code: input.errorCode,
        p_range_start: input.rangeStart,
        p_range_end: input.rangeEnd,
      })
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
    if (error) throw new Error(`结束记忆任务失败：${error.message}`);
    const result = isRecord(data) ? data : {};
    return {
      status: typeof result.status === 'string' ? result.status : 'unknown',
      attempts: typeof result.attempts === 'number' ? result.attempts : 0,
    };
  }

  /** 按轮次升序读取当前版本（已应用编辑/删除覆盖）。 */
  async readTurns(input: {
    sessionId: string;
    fromTurn: number;
    toTurn: number;
    limit: number;
  }): Promise<StoryTurn[]> {
    const { data, error } = await this.db
      .from('session_chat_history')
      .select('turn_index,user_input,assistant_reply')
      .eq('session_id', input.sessionId)
      .gte('turn_index', input.fromTurn)
      .lte('turn_index', input.toTurn)
      .order('turn_index', { ascending: true })
      .limit(input.limit)
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
    if (error) throw new Error(`读取待压缩轮次失败：${error.message}`);
    return toTurns(data);
  }

  /** 窗口内最近若干轮，只读上下文；未完成的生成没有正文，自然被过滤。 */
  async readRecentTurns(input: {
    sessionId: string;
    fromTurn: number;
    limit: number;
  }): Promise<StoryTurn[]> {
    if (input.limit <= 0) return [];
    const { data, error } = await this.db
      .from('session_chat_history')
      .select('turn_index,user_input,assistant_reply')
      .eq('session_id', input.sessionId)
      .gte('turn_index', input.fromTurn)
      .eq('status', 'success')
      .order('turn_index', { ascending: false })
      .limit(input.limit)
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
    if (error) throw new Error(`读取近期轮次失败：${error.message}`);
    return toTurns(data).reverse();
  }
}

function toTurns(data: unknown): StoryTurn[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row: unknown) => {
    if (!isRecord(row) || typeof row.turn_index !== 'number') return [];
    return [
      {
        turnIndex: row.turn_index,
        userInput: typeof row.user_input === 'string' ? row.user_input : '',
        assistantReply: typeof row.assistant_reply === 'string' ? row.assistant_reply : null,
      },
    ];
  });
}
