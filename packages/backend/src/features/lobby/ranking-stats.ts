/**
 * backend / features / lobby / ranking-stats.ts
 *
 * v3 排序分的库侧出入口：
 *   写：每日 job 调 computeRawCardStats() 聚合合格样本，算完分再 persistRankingScores() 落表
 *   读：大厅请求调 loadCharacterRankingScores() 只读汇总表，每卡一行
 *
 * 聚合要回看全历史确定用户资历，再在 80 天窗口内统计深度和回访，挂在读路径上撑不住，
 * 所以读写彻底分开——这也是 v2 的「每次请求查聚合视图」换掉的原因。
 */

import { DEFAULT_LOBBY_RANKING_PARAMS, type LobbyRankingParams } from '@miniapp/shared';
import { prisma } from '../../lib/db.js';
import type { RankingScore, RawCardStats } from './ranking-score.js';

/** 与大厅接口原有的缓存宽度一致。汇总表一天才变一次，60 秒纯粹是防重复查询 */
const RANKING_CACHE_TTL_MS = 60_000;

/** 排序时需要的最小信息量：分数用来排，样本量用来判断进主池还是冷启动池 */
export interface CardScore {
  score: number;
  sampleSize: number;
  qualityVersion?: string;
  trustedScore?: number;
  trustedSampleSize?: number;
  trustedAt?: number;
}

/**
 * 读路径拿到的一整份快照。
 *
 * minSample 跟着分数一起从表里读，而不是读路径自己去查一次运营配置：
 * 主池门槛必须和这批分数是同一版参数算出来的。否则运营刚把门槛从 20 调到 200，
 * 读路径立刻把几乎所有卡打进冷启动池随机化，而分数仍是按 20 算的——
 * 首页会先乱一天，等到下一次刷新才自洽。
 */
export interface RankingSnapshot {
  scores: Map<string, CardScore>;
  minSample: number;
}

/**
 * 聚合走刷新 job 持有 session advisory lock 的专用连接，落表走该连接上的短事务。
 * 两种客户端共用同一组查询方法，不引入第二条统计或持久化路径。
 */
export type RankingDbClient = Pick<typeof prisma, '$queryRaw' | '$executeRaw'>;

interface RawStatsRow {
  character_id: string;
  n_c: bigint | number;
  d30_raw: number | null;
  k_c: bigint | number;
  returned_c: bigint | number;
}

interface ScoreRow {
  character_id: string;
  n_c: number;
  score: string | number;
  min_users: number | null;
  quality_version: string | null;
  trusted_score: string | number | null;
  trusted_sample_size: number | null;
  trusted_at: Date | string | null;
}

let cache: { at: number; value: RankingSnapshot } | null = null;
/** TTL 过期瞬间大厅列表与金框快照会同时打穿；single-flight 避免共享池扇出。 */
let inflight: Promise<RankingSnapshot | null> | null = null;

export function clearCharacterRankingScoreCache(): void {
  cache = null;
  inflight = null;
}

/**
 * 读取每张卡的排序分。
 *
 * 表为空（job 还没跑过第一轮）或查询失败时返回 null——调用方必须据此退回运营顺序。
 * 这条兜底不能省：把空表当成「所有卡样本都是 0」会让整个大厅落进冷启动池被随机打乱。
 */
export async function loadCharacterRankingScores(): Promise<RankingSnapshot | null> {
  const now = Date.now();
  if (cache && now - cache.at < RANKING_CACHE_TTL_MS) return cache.value;
  if (inflight) return inflight;

  inflight = loadCharacterRankingScoresFresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function loadCharacterRankingScoresFresh(): Promise<RankingSnapshot | null> {
  try {
    const rows = await prisma.$queryRaw<ScoreRow[]>`
      SELECT character_id, n_c, score, min_users, quality_version,
             trusted_score, trusted_sample_size, trusted_at
      FROM miniapp_features.character_ranking_scores
    `;

    if (rows.length === 0) return cache?.value ?? null;

    const scores = new Map<string, CardScore>();
    for (const row of rows) {
      scores.set(row.character_id, {
        score: Number(row.score),
        sampleSize: Number(row.n_c),
        qualityVersion: row.quality_version ?? undefined,
        trustedScore: row.trusted_score == null ? undefined : Number(row.trusted_score),
        trustedSampleSize: row.trusted_sample_size ?? undefined,
        trustedAt: row.trusted_at == null ? undefined : new Date(row.trusted_at).getTime(),
      });
    }

    // 整表同值，取第一行即可。列是 088 加的，旧行理论上都有 DEFAULT，
    // 真读到 null 说明这批分数早于该迁移，用内置默认门槛比让整站进冷启动池安全。
    const storedMinSample = Number(rows[0]?.min_users);
    const value: RankingSnapshot = {
      scores,
      minSample:
        Number.isFinite(storedMinSample) && storedMinSample > 0
          ? storedMinSample
          : DEFAULT_LOBBY_RANKING_PARAMS.min_users,
    };
    cache = { at: Date.now(), value };
    return value;
  } catch (error) {
    console.warn('[lobby] 读取角色排序分失败，本次退回运营顺序', error);
    return cache?.value ?? null;
  }
}

/**
 * 在同一 SQL 快照里确定历史资格、D30 和 R48，避免资格重复扫描和统计时点漂移。
 *
 * 资格冻结在用户对这张卡的全历史首次发起时：此前首次有效聊天已满 24 小时，
 * 且第 10 个有效逻辑轮次已经完成。后来在这张卡成长，不会反向进入它的质量样本。
 * 有效轮次只用于判断资历；合格用户的深度仍沿用原发起轮次口径，包含失败占位。
 * R48 继续按窗口内发起时间切会话，只纳入首次会话结束已满观察期的该卡新客。
 */
export async function computeRawCardStats(
  db: RankingDbClient,
  params: LobbyRankingParams = DEFAULT_LOBBY_RANKING_PARAMS
): Promise<RawCardStats[]> {
  const lookbackDays = params.first_touch_lookback_days;
  const rows = await db.$queryRaw<RawStatsRow[]>`
    WITH bounds AS (
      SELECT
        now() AS now_at,
        now() - (${params.window_days}::int * interval '1 day') AS start_at
    ),
    history AS MATERIALIZED (
      -- 全历史只扫描一次，正文只在库内判断非空，不进入后续物化结果或应用。
      SELECT
        id,
        character_id,
        user_id,
        session_id,
        turn_index,
        created_at,
        CASE
          WHEN status = 'success'
            AND user_input ~ '[^[:space:]]'
            AND assistant_reply ~ '[^[:space:]]'
          -- 旧行没有独立完成时间时只能以创建时间近似；有结算时刻则不能提前计资历。
          THEN GREATEST(created_at, COALESCE(llm_billing_settled_at, created_at))
        END AS effective_at
      FROM experience.chat_history
    ),
    effective_turns AS (
      -- 重生成不增加资历；缺 session/turn 的 ST 历史按物理行保留。
      -- 成功 revision 的完成时间才有效，不能借同轮较早的失败时间回溯资格。
      SELECT user_id, MIN(effective_at) AS effective_at
      FROM history
      WHERE effective_at IS NOT NULL
      GROUP BY user_id, session_id, turn_index,
        CASE WHEN session_id IS NULL OR turn_index IS NULL THEN id END
    ),
    ordered_effective_turns AS (
      SELECT
        user_id,
        effective_at,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY effective_at) AS effective_turn_no
      FROM effective_turns
    ),
    experience_milestones AS (
      SELECT
        user_id,
        MIN(effective_at) AS first_effective_at,
        MAX(effective_at) FILTER (WHERE effective_turn_no = 10) AS tenth_effective_at
      FROM ordered_effective_turns
      WHERE effective_turn_no <= 10
      GROUP BY user_id
    ),
    card_first_touch AS (
      SELECT
        h.character_id,
        h.user_id,
        MIN(h.created_at) AS first_at,
        MIN(h.created_at) FILTER (
          WHERE ${lookbackDays}::int IS NULL
            OR h.created_at >= b.start_at - (${lookbackDays}::int * interval '1 day')
        ) AS observed_first_at
      FROM history h
      CROSS JOIN bounds b
      WHERE h.character_id IS NOT NULL
      GROUP BY h.character_id, h.user_id
    ),
    qualified_pairs AS (
      SELECT ft.character_id, ft.user_id, ft.observed_first_at
      FROM card_first_touch ft
      JOIN experience_milestones m ON m.user_id = ft.user_id
      -- 首触含失败尝试；24h 可恰好满足，但同刻完成第 10 轮不算事前完成。
      WHERE ft.first_at >= m.first_effective_at + interval '24 hours'
        AND ft.first_at > m.tenth_effective_at
    ),
    active_cards AS (
      -- 保留原始活动卡作为结果全集：全被资格过滤的卡也必须写 n=0，覆盖旧污染分。
      SELECT DISTINCT h.character_id
      FROM history h
      CROSS JOIN bounds b
      WHERE h.character_id IS NOT NULL AND h.created_at >= b.start_at
    ),
    qualified_window AS MATERIALIZED (
      SELECT h.id, h.character_id, h.user_id, h.session_id, h.turn_index, h.created_at,
        q.observed_first_at
      FROM history h
      JOIN qualified_pairs q ON q.character_id = h.character_id AND q.user_id = h.user_id
      CROSS JOIN bounds b
      WHERE h.created_at >= b.start_at
    ),
    depth_by_user AS (
      -- D30 沿用既有发起轮次口径：ST 一行一轮，自研同轮 revision 去重，失败不删。
      SELECT
        character_id,
        user_id,
        (
          COUNT(*) FILTER (WHERE session_id IS NULL)
          + COUNT(DISTINCT (session_id, turn_index)) FILTER (WHERE session_id IS NOT NULL)
        )::int AS turns
      FROM qualified_window
      GROUP BY character_id, user_id
    ),
    depth_by_card AS (
      SELECT
        character_id,
        COUNT(*)::bigint AS n_c,
        AVG(LEAST(turns, ${params.turn_cap}::int))::double precision
          / ${params.turn_cap}::int AS d30_raw
      FROM depth_by_user
      GROUP BY character_id
    ),
    gapped AS (
      SELECT
        h.id,
        h.character_id,
        h.user_id,
        h.created_at,
        LAG(h.created_at) OVER (
          PARTITION BY h.character_id, h.user_id ORDER BY h.created_at, h.id
        ) AS prev_at
      FROM qualified_window h
      CROSS JOIN bounds b
      -- 有界回溯只影响原 R48 新客观察，绝不截短平台资历或该卡真实首触。
      WHERE h.observed_first_at >= b.start_at
    ),
    sessionized AS (
      SELECT
        character_id,
        user_id,
        created_at,
        SUM(
          CASE
            WHEN prev_at IS NULL
              OR created_at - prev_at
                 > (${params.session_gap_minutes}::int * interval '1 minute')
            THEN 1 ELSE 0
          END
        ) OVER (
          PARTITION BY character_id, user_id ORDER BY created_at, id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS session_no
      FROM gapped
    ),
    first_two AS (
      SELECT
        character_id,
        user_id,
        session_no,
        MIN(created_at) AS session_start,
        MAX(created_at) AS session_end
      FROM sessionized
      WHERE session_no <= 2
      GROUP BY character_id, user_id, session_no
    ),
    pivoted AS (
      SELECT
        character_id,
        user_id,
        MAX(session_end)   FILTER (WHERE session_no = 1) AS end_first,
        MAX(session_start) FILTER (WHERE session_no = 2) AS start_second
      FROM first_two
      GROUP BY character_id, user_id
    ),
    returns_by_card AS (
      SELECT
        p.character_id,
        COUNT(*) FILTER (
          WHERE p.end_first
                <= b.now_at - (${params.return_window_hours}::int * interval '1 hour')
        )::bigint AS k_c,
        COUNT(*) FILTER (
          WHERE p.end_first
                <= b.now_at - (${params.return_window_hours}::int * interval '1 hour')
            AND p.start_second IS NOT NULL
            AND p.start_second
                <= p.end_first + (${params.return_window_hours}::int * interval '1 hour')
        )::bigint AS returned_c
      FROM pivoted p
      CROSS JOIN bounds b
      GROUP BY p.character_id
    )
    SELECT
      c.character_id,
      COALESCE(d.n_c, 0)::bigint AS n_c,
      d.d30_raw,
      COALESCE(r.k_c, 0)::bigint AS k_c,
      COALESCE(r.returned_c, 0)::bigint AS returned_c
    FROM active_cards c
    LEFT JOIN depth_by_card d ON d.character_id = c.character_id
    LEFT JOIN returns_by_card r ON r.character_id = c.character_id
  `;

  return rows.map((row) => {
    const returnSampleSize = Number(row.k_c);
    return {
      characterId: row.character_id,
      sampleSize: Number(row.n_c),
      d30Raw: row.d30_raw === null ? null : Number(row.d30_raw),
      returnSampleSize,
      // 分母为 0 时留 null：「没有样本」与「回访率为 0」在收缩时是两种待遇。
      r48Raw: returnSampleSize > 0 ? Number(row.returned_c) / returnSampleSize : null,
    };
  });
}

/**
 * 覆盖式落表：写入本轮算出的所有卡，并清掉不在本轮结果里的陈旧行。
 *
 * 不清理的话，一张卡的最后一条对话滑出 80 天窗口后会永远留着上一轮的分数，
 * 表面上还是成熟卡。
 */
export async function persistRankingScores(
  db: RankingDbClient,
  scores: readonly RankingScore[],
  params: LobbyRankingParams = DEFAULT_LOBBY_RANKING_PARAMS
): Promise<void> {
  if (scores.length === 0) return;

  // 整批走一个 jsonb 参数而不是七个并行数组：数组参数的元素类型要靠推断，
  // 而 d30_raw / r48_raw 允许整列为 null，那种情况下推断不出可用的类型。
  const payload = JSON.stringify(
    scores.map((row) => ({
      character_id: row.characterId,
      n_c: row.sampleSize,
      d30_raw: row.d30Raw,
      d30_shrunk: row.d30Shrunk,
      k_c: row.returnSampleSize,
      r48_raw: row.r48Raw,
      score: row.score,
    }))
  );

  await db.$executeRaw`
    INSERT INTO miniapp_features.character_ranking_scores (
      character_id, n_c, d30_raw, d30_shrunk, k_c, r48_raw, score,
      window_days, min_users, computed_at, quality_version,
      trusted_score, trusted_sample_size, trusted_at
    )
    SELECT
      t.character_id, t.n_c, t.d30_raw, t.d30_shrunk, t.k_c, t.r48_raw, t.score,
      ${params.window_days}::int, ${params.min_users}::int, now(), 'qualified-v1',
      CASE WHEN t.n_c >= ${params.min_users}::int THEN t.score END,
      CASE WHEN t.n_c >= ${params.min_users}::int THEN t.n_c END,
      CASE WHEN t.n_c >= ${params.min_users}::int THEN now() END
    FROM jsonb_to_recordset(${payload}::jsonb) AS t(
      character_id uuid,
      n_c          integer,
      d30_raw      double precision,
      d30_shrunk   double precision,
      k_c          integer,
      r48_raw      double precision,
      score        numeric
    )
    -- chat_history 里可能留有已删除角色的日志，直接插会撞外键
    WHERE EXISTS (SELECT 1 FROM app_core.characters c WHERE c.id = t.character_id)
    ON CONFLICT (character_id) DO UPDATE SET
      n_c         = EXCLUDED.n_c,
      d30_raw     = EXCLUDED.d30_raw,
      d30_shrunk  = EXCLUDED.d30_shrunk,
      k_c         = EXCLUDED.k_c,
      r48_raw     = EXCLUDED.r48_raw,
      score       = EXCLUDED.score,
      window_days = EXCLUDED.window_days,
      min_users   = EXCLUDED.min_users,
      computed_at = EXCLUDED.computed_at,
      quality_version = EXCLUDED.quality_version,
      trusted_score = COALESCE(EXCLUDED.trusted_score,
        miniapp_features.character_ranking_scores.trusted_score),
      trusted_sample_size = COALESCE(EXCLUDED.trusted_sample_size,
        miniapp_features.character_ranking_scores.trusted_sample_size),
      trusted_at = COALESCE(EXCLUDED.trusted_at,
        miniapp_features.character_ranking_scores.trusted_at)
  `;

  await db.$executeRaw`
    DELETE FROM miniapp_features.character_ranking_scores AS target
    WHERE target.trusted_at IS NULL AND NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(${payload}::jsonb) AS t(character_id uuid)
      WHERE t.character_id = target.character_id
    )
  `;

  // No recent traffic is not new evidence of poor quality. Keep the last qualified observation,
  // while clearing the current sample so dormant cards cannot pretend to have fresh evidence.
  await db.$executeRaw`
    UPDATE miniapp_features.character_ranking_scores AS target SET
      n_c = 0, d30_raw = NULL, k_c = 0, r48_raw = NULL,
      quality_version = 'qualified-v1', computed_at = now(),
      window_days = ${params.window_days}::int, min_users = ${params.min_users}::int
    WHERE target.trusted_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(${payload}::jsonb) AS t(character_id uuid)
      WHERE t.character_id = target.character_id
    )
  `;
}
