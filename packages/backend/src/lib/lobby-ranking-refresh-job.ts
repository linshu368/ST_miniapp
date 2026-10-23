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
 *
 * 为什么走 DIRECT_URL 的独立客户端（2026-10-22）：
 * 这条事务要跑几分钟，而 API 的共享池只有 connection_limit=10 条（Supavisor 事务模式，
 * pool_timeout=10s）。滚动发布时每个副本都会在启动 30 秒后跑一轮，几个副本的长事务
 * 同时压在同一个池上，就把池占满，其它请求排队满 10 秒后集体超时——生产上看到的
 * 正是这个：连接获取耗时集中在少数几秒的窗口里，而不是均匀变慢。
 * 换成专用连接后，这段时间不再从共享额度里扣。
 *
 * 用独立 PrismaClient 而不是 postgres-advisory-lease 那种 pg.Client：聚合 SQL 是
 * Prisma 的模板字面量标签语法，换驱动要把 ranking-stats.ts 里的 SQL 全部重写成
 * $1/$2 占位符，风险远大于收益。DIRECT_URL 在这里是安全的——锁定用的是
 * pg_try_advisory_xact_lock，事务级、随事务结束自动释放，不依赖 session 保持。
 */

import type { FastifyBaseLogger } from 'fastify';
import { PrismaClient } from '@prisma/client';
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

/**
 * 事务超时。两条聚合在大表上可能跑几分钟，Prisma 默认的 5 秒远不够。
 *
 * 必须大于 STATEMENT_TIMEOUT_MS：否则 Prisma 先超时，日志里拿不到 Postgres 的
 * 「canceling statement due to statement timeout」，会误判成事务层卡死。
 */
const TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 库侧单条语句的上限，必须在事务内显式抬高。
 *
 * 平台默认 statement_timeout=120s（/etc/postgresql-custom/platform-defaults.conf），
 * 而连接用户 postgres 没有任何角色级覆盖，所以 job 实际吃的是这 120 秒。两条 80 天
 * 窗口的聚合在这张表上跑不完 120 秒——生产证据：聚合 span p95 恰好 120.0s，
 * character_ranking_scores 最后一次成功写入停在 2026-10-20，之后每轮都在聚合处
 * 被掐断并整体回滚。这条不修，光换连接池（本文件上半部分的改动）也不会让刷新恢复。
 */
const STATEMENT_TIMEOUT_MS = 8 * 60 * 1000;

/**
 * 等连接的上限。
 *
 * 必须小于专属池的 pool_timeout（10s）：Prisma 的 maxWait 和连接池自身的等待超时
 * 是两层，若 maxWait 更大，池会先超时，maxWait 永远不生效，日志里也留不下痕迹。
 * 专属池只有 1 条连接、无竞争者，这里取 5 秒足够——真等到 5 秒说明连接泄漏了。
 */
const TRANSACTION_MAX_WAIT_MS = 5 * 1000;

/** 专属池的连接等待超时，与 DATABASE_URL 上的 pool_timeout 保持同一量级 */
const DIRECT_POOL_TIMEOUT_S = 10;

/** advisory lock 的 key，全局唯一即可，与其它 job 不要撞 */
const ADVISORY_LOCK_KEY = 740_074;

let timerId: NodeJS.Timeout | null = null;
let startupTimerId: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * 构造指向 DIRECT_URL 的专用客户端。
 *
 * 强制 connection_limit=1：每次刷新只有一个事务，多开连接纯属浪费直连额度
 * （Supabase 免费/小规格的 max_connections 并不宽裕）。
 *
 * 缺 DIRECT_URL 时返回 null 而不是回退到共享池——回退等于这次优化没做，
 * 而且会让「job 又去挤 API 的池」这种故障静默复发。
 */
function createDedicatedClient(): PrismaClient | null {
  const directUrl = process.env.DIRECT_URL?.trim();
  if (!directUrl) return null;

  let url: URL;
  try {
    url = new URL(directUrl);
  } catch {
    return null;
  }

  // 覆盖而非追加，避免 DIRECT_URL 里已有的连接数把这里顶掉
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('pool_timeout', String(DIRECT_POOL_TIMEOUT_S));

  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

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

  const dedicated = createDedicatedClient();
  if (!dedicated) {
    log.error(
      { kind: 'sys', event: 'lobby_ranking.skipped_no_direct_url' },
      'DIRECT_URL 未配置或非法，跳过本轮刷新：专用连接不可用时不回退到 API 共享池'
    );
    return;
  }

  isRunning = true;

  const startedAt = Date.now();

  try {
    // 配置读在事务外：它走 Supabase REST，与事务用的是不同连接，
    // 放进去只是白白占着 advisory lock 等一个网络往返。
    const { params, degraded, version } = await resolveLobbyRankingParams(log);

    const outcome = await dedicated.$transaction(
      async (tx) => {
        // 抬高库侧语句超时。set_config 第三个参数 true = 仅本事务有效，随提交/回滚
        // 自动还原，不会把 8 分钟的上限留给池里复用的那条连接。
        // 必须放在 advisory lock 之前：锁本身不耗时，但聚合要在这个上限下才跑得完。
        await tx.$queryRaw`
          SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)
        `;

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

    // 每轮都必须断开。专用客户端的池是长连的，若留在进程里，滚动发布会累积
    // 一批再也不用的连接，直连额度被慢慢吃干净（生产上已见过类似的长 idle 连接）。
    try {
      await dedicated.$disconnect();
    } catch (err) {
      log.warn(
        { kind: 'sys', event: 'lobby_ranking.disconnect_failed', err },
        '释放专用数据库连接失败'
      );
    }
  }
}
