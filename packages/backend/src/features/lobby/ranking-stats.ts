/**
 * backend / features / lobby / ranking-stats.ts
 *
 * v3 排序分的库侧出入口：
 *   写：每日 job 调 computeRawCardStats() 跑两条聚合，算完分再 persistRankingScores() 落表
 *   读：大厅请求调 loadCharacterRankingScores() 只读汇总表，每卡一行
 *
 * 聚合本身是 80 天窗口的全表级扫描（还要 LAG 切会话），挂在读路径上撑不住，
 * 所以读写彻底分开——这也是 v2 的「每次请求查聚合视图」换掉的原因。
 */

import { prisma } from '../../lib/db.js';
import {
  D30_TURN_CAP,
  LOBBY_RANKING_WINDOW_DAYS,
  type RankingScore,
  type RawCardStats,
} from './ranking-score.js';

/** 与大厅接口原有的缓存宽度一致。汇总表一天才变一次，60 秒纯粹是防重复查询 */
const RANKING_CACHE_TTL_MS = 60_000;

/** 会话切分阈值：相邻两条消息间隔超过它就算新会话 */
const SESSION_GAP_MINUTES = 30;

/** 回访窗口 */
const RETURN_WINDOW_HOURS = 48;

/** 排序时需要的最小信息量：分数用来排，样本量用来判断进主池还是冷启动池 */
export interface CardScore {
  score: number;
  sampleSize: number;
}

/**
 * 写路径要能跑在事务客户端上：刷新 job 用事务级 advisory lock 防多副本重复跑，
 * 而这种锁只在持锁的那条连接上有效，聚合与落表必须走同一个客户端。
 */
export type RankingDbClient = Pick<typeof prisma, '$queryRaw' | '$executeRaw'>;

interface DepthRow {
  character_id: string;
  n_c: bigint | number;
  d30_raw: number | null;
}

interface ReturnRow {
  character_id: string;
  k_c: bigint | number;
  returned_c: bigint | number;
}

interface ScoreRow {
  character_id: string;
  n_c: number;
  score: string | number;
}

let cache: { at: number; value: Map<string, CardScore> } | null = null;

export function clearCharacterRankingScoreCache(): void {
  cache = null;
}

/**
 * 读取每张卡的排序分。
 *
 * 表为空（job 还没跑过第一轮）或查询失败时返回 null——调用方必须据此退回运营顺序。
 * 这条兜底不能省：把空表当成「所有卡样本都是 0」会让整个大厅落进冷启动池被随机打乱。
 */
export async function loadCharacterRankingScores(): Promise<Map<string, CardScore> | null> {
  const now = Date.now();
  if (cache && now - cache.at < RANKING_CACHE_TTL_MS) return cache.value;

  try {
    const rows = await prisma.$queryRaw<ScoreRow[]>`
      SELECT character_id, n_c, score
      FROM miniapp.character_ranking_scores
    `;

    if (rows.length === 0) return cache?.value ?? null;

    const value = new Map<string, CardScore>();
    for (const row of rows) {
      value.set(row.character_id, {
        score: Number(row.score),
        sampleSize: Number(row.n_c),
      });
    }
    cache = { at: now, value };
    return value;
  } catch (error) {
    console.warn('[lobby] 读取角色排序分失败，本次退回运营顺序', error);
    return cache?.value ?? null;
  }
}

/**
 * 跑两条聚合，产出每卡原始量。
 *
 * 拆成两条而不是一条大查询：D30 只看窗口内的行，R48 要回溯全历史定新客，
 * 两者的扫描范围与分组键都不同，合并只会让计划器两头不讨好。
 */
export async function computeRawCardStats(
  db: RankingDbClient,
  windowDays: number = LOBBY_RANKING_WINDOW_DAYS
): Promise<RawCardStats[]> {
  // 事务客户端上的查询必须串行：交互式事务同一时刻只处理一条语句
  const perRevisionRows = await hasConversationTurnColumns(db);
  const depthRows = perRevisionRows
    ? await queryDepthByTurn(db, windowDays)
    : await queryDepthByRow(db, windowDays);
  const returnRows = await queryReturnRate(db, windowDays);

  const returnByCard = new Map<string, ReturnRow>();
  for (const row of returnRows) returnByCard.set(row.character_id, row);

  const stats: RawCardStats[] = depthRows.map((row) => {
    const ret = returnByCard.get(row.character_id);
    const returnSampleSize = ret ? Number(ret.k_c) : 0;
    const returned = ret ? Number(ret.returned_c) : 0;

    return {
      characterId: row.character_id,
      sampleSize: Number(row.n_c),
      d30Raw: row.d30_raw === null ? null : Number(row.d30_raw),
      returnSampleSize,
      // 分母为 0 时留 null：「没有样本」与「回访率为 0」在收缩时是两种待遇
      r48Raw: returnSampleSize > 0 ? returned / returnSampleSize : null,
    };
  });

  // 只有新客、窗口内却没有任何对话的卡进不了 depthRows，但那不可能——
  // 新客判定本身就来自 chat_history，所以 returnRows 一定是 depthRows 的子集。
  return stats;
}

/**
 * chat_history 是否已经有 session_id / turn_index（migration 069 与 072）。
 *
 * 这两列决定 turns 怎么数，而生产库在 M6 切换前不会有它们，
 * 无条件引用会让每日 job 每轮直接报错。探测一次比让 job 崩掉便宜。
 * 069~073 在所有环境执行完之后，这个分支连同 queryDepthByRow 一起删掉。
 */
async function hasConversationTurnColumns(db: RankingDbClient): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ present: boolean }>>`
    SELECT COUNT(*) = 2 AS present
    FROM information_schema.columns
    WHERE table_schema = 'miniapp'
      AND table_name = 'chat_history'
      AND column_name IN ('session_id', 'turn_index')
  `;
  return rows[0]?.present === true;
}

/**
 * D30 与样本量：turns 取窗口内的行数。
 *
 * 不用 user_character_round——那是全历史累计值，一个三年前聊过 200 轮的用户
 * 会让任何时间窗都失去意义。
 *
 * 072 之前 chat_history 一行就是一轮，行数即轮数。
 */
function queryDepthByRow(db: RankingDbClient, windowDays: number): Promise<DepthRow[]> {
  return db.$queryRaw<DepthRow[]>`
    WITH windowed AS (
      SELECT character_id, user_id, COUNT(*)::int AS turns
      FROM miniapp.chat_history
      WHERE character_id IS NOT NULL
        AND created_at >= now() - (${windowDays}::int * interval '1 day')
      GROUP BY character_id, user_id
    )
    SELECT
      character_id,
      COUNT(*)::bigint AS n_c,
      AVG(LEAST(turns, ${D30_TURN_CAP}::int))::double precision / ${D30_TURN_CAP}::int AS d30_raw
    FROM windowed
    GROUP BY character_id
  `;
}

/**
 * 072 之后的 D30：自研链路一行是一个 revision，重生成会在同一轮里多出若干行。
 *
 * 直接数行会把「同一句话重生成五次」算成五轮深度，正好奖励了用户不满意的卡。
 * 所以自研行按 (session_id, turn_index) 去重，ST 行仍是一行一轮。
 * 402 / 上游失败预建的行留在计数里——用户确实发起了这一轮，与既有视图口径一致。
 *
 * R48 不受影响：多出来的 revision 只是同一会话内多几个时间点，
 * 30 分钟切分与首末时间都不变。
 */
function queryDepthByTurn(db: RankingDbClient, windowDays: number): Promise<DepthRow[]> {
  return db.$queryRaw<DepthRow[]>`
    WITH windowed AS (
      SELECT
        character_id,
        user_id,
        (
          COUNT(*) FILTER (WHERE session_id IS NULL)
          + COUNT(DISTINCT (session_id, turn_index)) FILTER (WHERE session_id IS NOT NULL)
        )::int AS turns
      FROM miniapp.chat_history
      WHERE character_id IS NOT NULL
        AND created_at >= now() - (${windowDays}::int * interval '1 day')
      GROUP BY character_id, user_id
    )
    SELECT
      character_id,
      COUNT(*)::bigint AS n_c,
      AVG(LEAST(turns, ${D30_TURN_CAP}::int))::double precision / ${D30_TURN_CAP}::int AS d30_raw
    FROM windowed
    GROUP BY character_id
  `;
}

/**
 * R48：新客首次会话结束后 48 小时内是否回访。
 *
 * 三个口径上的讲究：
 *   - 新客判定用「全历史首次交互落在窗口内」。chat_history 从无清理，这个判定是精确的；
 *     用窗口内首次会误判——老用户在窗口内的第一条会被当成新客。
 *   - 分母只收首次会话已结束满 48 小时的人。不满 48 小时的样本还没走完观察期，
 *     提前计入等于把「还没来得及回访」算成「没有回访」。
 *   - 只需要前两个会话，session_no > 2 的行在聚合前就丢掉。
 */
function queryReturnRate(db: RankingDbClient, windowDays: number): Promise<ReturnRow[]> {
  return db.$queryRaw<ReturnRow[]>`
    WITH bounds AS (
      SELECT now() AS now_at, now() - (${windowDays}::int * interval '1 day') AS start_at
    ),
    first_touch AS (
      SELECT character_id, user_id, MIN(created_at) AS first_at
      FROM miniapp.chat_history
      WHERE character_id IS NOT NULL
      GROUP BY character_id, user_id
    ),
    newcomers AS (
      SELECT ft.character_id, ft.user_id
      FROM first_touch ft, bounds b
      WHERE ft.first_at >= b.start_at
    ),
    gapped AS (
      SELECT
        h.character_id,
        h.user_id,
        h.created_at,
        LAG(h.created_at) OVER (
          PARTITION BY h.character_id, h.user_id ORDER BY h.created_at
        ) AS prev_at
      FROM miniapp.chat_history h
      JOIN newcomers n ON n.character_id = h.character_id AND n.user_id = h.user_id
      WHERE h.character_id IS NOT NULL
    ),
    sessionized AS (
      SELECT
        character_id,
        user_id,
        created_at,
        SUM(
          CASE
            WHEN prev_at IS NULL
              OR created_at - prev_at > (${SESSION_GAP_MINUTES}::int * interval '1 minute')
            THEN 1 ELSE 0
          END
        ) OVER (
          PARTITION BY character_id, user_id ORDER BY created_at
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
    )
    SELECT
      p.character_id,
      COUNT(*) FILTER (
        WHERE p.end_first <= b.now_at - (${RETURN_WINDOW_HOURS}::int * interval '1 hour')
      )::bigint AS k_c,
      COUNT(*) FILTER (
        WHERE p.end_first <= b.now_at - (${RETURN_WINDOW_HOURS}::int * interval '1 hour')
          AND p.start_second IS NOT NULL
          AND p.start_second <= p.end_first + (${RETURN_WINDOW_HOURS}::int * interval '1 hour')
      )::bigint AS returned_c
    FROM pivoted p, bounds b
    GROUP BY p.character_id
  `;
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
  windowDays: number = LOBBY_RANKING_WINDOW_DAYS
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
    INSERT INTO miniapp.character_ranking_scores (
      character_id, n_c, d30_raw, d30_shrunk, k_c, r48_raw, score, window_days, computed_at
    )
    SELECT
      t.character_id, t.n_c, t.d30_raw, t.d30_shrunk, t.k_c, t.r48_raw, t.score,
      ${windowDays}::int, now()
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
    WHERE EXISTS (SELECT 1 FROM miniapp.characters c WHERE c.id = t.character_id)
    ON CONFLICT (character_id) DO UPDATE SET
      n_c         = EXCLUDED.n_c,
      d30_raw     = EXCLUDED.d30_raw,
      d30_shrunk  = EXCLUDED.d30_shrunk,
      k_c         = EXCLUDED.k_c,
      r48_raw     = EXCLUDED.r48_raw,
      score       = EXCLUDED.score,
      window_days = EXCLUDED.window_days,
      computed_at = EXCLUDED.computed_at
  `;

  await db.$executeRaw`
    DELETE FROM miniapp.character_ranking_scores AS target
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(${payload}::jsonb) AS t(character_id uuid)
      WHERE t.character_id = target.character_id
    )
  `;
}
