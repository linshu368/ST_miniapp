/**
 * backend / lib / lobby-ranking-refresh-job.ts
 *
 * 大厅推荐 v3 排序分的每日刷新。
 *
 * 为什么是 job 而不是查询时算：80 天窗口的两条聚合都是全表级扫描，其中 R48 还要
 * 回溯全历史定新客并用 LAG 切会话。挂在读路径上，首页每次刷新都会付这个成本。
 *
 * 为什么整轮包在一个事务里：Railway 可能跑多副本，每个副本都有自己的 setInterval，
 * 没有互斥就是同一份聚合被算 N 遍、落表时互相覆盖。这里用事务级 advisory lock，
 * 它只在持锁的那条连接上有效且随事务自动释放——所以聚合与落表都必须走 tx，
 * 不能一边持锁一边用连接池里的另一条连接干活。
 */

import type { FastifyBaseLogger } from 'fastify';
import { prisma } from './db.js';
import { computeRankingScores } from '../features/lobby/ranking-score.js';
import { resolveLobbyRankingParams } from '../features/lobby/ranking-params.js';
import {
  clearCharacterRankingScoreCache,
  computeRawCardStats,
  persistRankingScores,
} from '../features/lobby/ranking-stats.js';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 启动后先跑一次把汇总表填上。首次部署时表是空的，读路径会一直退回运营顺序，
 * 所以这个延迟不宜太长；又要躲开冷启动时的其它初始化，取 30 秒。
 */
const STARTUP_DELAY_MS = 30 * 1000;

/** 事务超时。两条聚合在大表上可能跑几分钟，Prisma 默认的 5 秒远不够 */
const TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSACTION_MAX_WAIT_MS = 15 * 1000;

/** advisory lock 的 key，全局唯一即可，与其它 job 不要撞 */
const ADVISORY_LOCK_KEY = 740_074;

let timerId: NodeJS.Timeout | null = null;
let startupTimerId: NodeJS.Timeout | null = null;
let isRunning = false;

export function startLobbyRankingRefreshJob(log: FastifyBaseLogger): void {
  if (timerId || startupTimerId) return;

  const jlog = log.child({ module: 'lobby-ranking-refresh' });

  timerId = setInterval(() => {
    void runLobbyRankingRefresh(jlog);
  }, REFRESH_INTERVAL_MS);

  startupTimerId = setTimeout(() => {
    startupTimerId = null;
    void runLobbyRankingRefresh(jlog);
  }, STARTUP_DELAY_MS);

  jlog.info({ kind: 'sys', event: 'lobby_ranking.started' }, 'Lobby ranking refresh job started');
}

export function stopLobbyRankingRefreshJob(): void {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  if (startupTimerId) {
    clearTimeout(startupTimerId);
    startupTimerId = null;
  }
}

/** 导出供手动触发使用；正常运行只由定时器调用 */
export async function runLobbyRankingRefresh(log: FastifyBaseLogger): Promise<void> {
  if (isRunning) {
    log.info({ kind: 'sys', event: 'lobby_ranking.skipped_local' }, '上一轮刷新还在跑，跳过本次');
    return;
  }
  isRunning = true;

  const startedAt = Date.now();

  try {
    // 配置读在事务外：它走 Supabase REST，与事务用的是不同连接，
    // 放进去只是白白占着 advisory lock 等一个网络往返。
    const { params, degraded, version } = await resolveLobbyRankingParams(log);

    const outcome = await prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}::bigint) AS locked
        `;
        if (rows[0]?.locked !== true) return null;

        const raw = await computeRawCardStats(tx, params);
        const scores = computeRankingScores(raw, params);

        // 空结果意味着整个窗口内一条对话都没有。真实环境不可能，
        // 更像是聚合出了问题——这种时候清表会把整个大厅打回随机顺序，宁可不动。
        if (scores.length === 0) return { cardCount: 0, matureCount: 0, skippedEmpty: true };

        await persistRankingScores(tx, scores, params);

        return {
          cardCount: scores.length,
          matureCount: scores.filter((row) => row.sampleSize >= params.min_users).length,
          skippedEmpty: false,
        };
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS }
    );

    if (!outcome) {
      log.info(
        { kind: 'sys', event: 'lobby_ranking.skipped_locked' },
        '另一副本正在刷新，跳过本次'
      );
      return;
    }

    if (outcome.skippedEmpty) {
      log.warn(
        { kind: 'sys', event: 'lobby_ranking.skipped_empty', durationMs: Date.now() - startedAt },
        '聚合结果为空，保留上一轮分数'
      );
      return;
    }

    // 事务提交后再让读路径失效，否则缓存可能填进还没提交的旧值
    clearCharacterRankingScoreCache();

    log.info(
      {
        kind: 'sys',
        event: 'lobby_ranking.completed',
        cardCount: outcome.cardCount,
        matureCount: outcome.matureCount,
        durationMs: Date.now() - startedAt,
        windowDays: params.window_days,
        // 这一轮分数是哪版参数算的。运营改完配置来核对时唯一的凭据
        paramsVersion: version,
        paramsDegraded: degraded,
      },
      '大厅排序分刷新完成'
    );
  } catch (err) {
    // 失败即回滚，表里仍是上一轮的分。宁可用昨天的顺序，也不要退回全量运营顺序
    log.error(
      { kind: 'sys', event: 'lobby_ranking.failed', err, durationMs: Date.now() - startedAt },
      '大厅排序分刷新失败，沿用上一轮结果'
    );
  } finally {
    isRunning = false;
  }
}
