/**
 * backend / lib / lobby-ranking-refresh-job.ts
 *
 * 大厅推荐 v3 排序分的每日刷新。
 *
 * 为什么是 job 而不是查询时算：80 天窗口的两条聚合都是全表级扫描，其中 R48 还要
 * 回溯全历史定新客并用 LAG 切会话。挂在读路径上，首页每次刷新都会付这个成本。
 *
 * 为什么走 DIRECT_URL 的独立客户端（2026-10-22）：
 * 聚合要跑几分钟，而 API 的共享池只有 connection_limit=10。滚动发布时每个副本都会在
 * 启动 30 秒后跑一轮，几个副本的长事务同时压在同一个池上就会把池占满。换成专用连接后，
 * 这段时间不再从共享额度里扣；缺 DIRECT_URL 时跳过本轮，禁止回退共享池。
 *
 * 为什么用 session advisory lock、而不是整轮包在交互式长事务里（2026-10-26）：
 * 以前 `pg_try_advisory_xact_lock` + `$transaction` 会让 Postgres 在整段聚合期间持有
 * 一个打开的事务快照（常达数分钟）。直连额度虽已隔离，长事务仍加重 vacuum/可见性与
 * 后端压力。改为 `pg_try_advisory_lock`（session 级）后：聚合语句各自短提交，仅落表
 * 用短事务包住 INSERT+DELETE；`connection_limit=1` 保证锁与查询落在同一条连接上。
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
 * 库侧单条语句的上限，必须在专用连接上显式抬高。
 *
 * 平台默认 statement_timeout=120s；两条 80 天聚合在这张表上跑不完 120 秒。
 * 用 session 级 set_config（第三个参数 false），finally 里再 RESET，避免留给下轮连接。
 */
const STATEMENT_TIMEOUT_MS = 8 * 60 * 1000;

/** 落表短事务：只包 INSERT+DELETE，远小于聚合耗时 */
const PERSIST_TRANSACTION_TIMEOUT_MS = 60 * 1000;

/**
 * 短事务等连接的上限。必须小于专属池的 pool_timeout（10s）。
 * 专属池只有 1 条连接、无竞争者，5 秒足够——真等到 5 秒说明连接泄漏了。
 */
const PERSIST_MAX_WAIT_MS = 5 * 1000;

/** 专属池的连接等待超时 */
const DIRECT_POOL_TIMEOUT_S = 10;

/** advisory lock 的 key，全局唯一即可，与其它 job 不要撞 */
const ADVISORY_LOCK_KEY = 740_074;

let timerId: NodeJS.Timeout | null = null;
let startupTimerId: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * 构造指向 DIRECT_URL 的专用客户端。
 *
 * 强制 connection_limit=1：session advisory lock 依赖「锁与后续查询在同一连接」；
 * 多开连接会把锁打到 A、查询跑到 B，互斥失效。
 *
 * 缺 DIRECT_URL 时返回 null 而不是回退到共享池。
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
  let lockHeld = false;

  try {
    // 配置读在锁外：走 Supabase REST，与专用连接无关。
    const { params, degraded, version } = await resolveLobbyRankingParams(log);

    const lockRows = await dedicated.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}::bigint) AS locked
    `;
    if (lockRows[0]?.locked !== true) {
      log.info(
        { kind: 'sys', event: 'lobby_ranking.skipped_locked' },
        '另一副本正在刷新，跳过本次'
      );
      return;
    }
    lockHeld = true;

    await dedicated.$queryRaw`
      SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, false)
    `;

    const raw = await computeRawCardStats(dedicated, params);
    const scores = computeRankingScores(raw, params);

    // 空结果意味着整个窗口内一条对话都没有。真实环境不可能，
    // 更像是聚合出了问题——这种时候清表会把整个大厅打回随机顺序，宁可不动。
    if (scores.length === 0) {
      log.warn(
        { kind: 'sys', event: 'lobby_ranking.skipped_empty', durationMs: Date.now() - startedAt },
        '聚合结果为空，保留上一轮分数'
      );
      return;
    }

    // 落表单独短事务：避免 INSERT 成功、DELETE 失败留下半截覆盖态。
    await dedicated.$transaction(
      async (tx) => {
        await persistRankingScores(tx, scores, params);
      },
      { timeout: PERSIST_TRANSACTION_TIMEOUT_MS, maxWait: PERSIST_MAX_WAIT_MS }
    );

    // 提交后再让读路径失效，否则缓存可能填进还没提交的旧值
    clearCharacterRankingScoreCache();

    log.info(
      {
        kind: 'sys',
        event: 'lobby_ranking.completed',
        cardCount: scores.length,
        matureCount: scores.filter((row) => row.sampleSize >= params.min_users).length,
        durationMs: Date.now() - startedAt,
        windowDays: params.window_days,
        paramsVersion: version,
        paramsDegraded: degraded,
      },
      '大厅排序分刷新完成'
    );
  } catch (err) {
    log.error(
      { kind: 'sys', event: 'lobby_ranking.failed', err, durationMs: Date.now() - startedAt },
      '大厅排序分刷新失败，沿用上一轮结果'
    );
  } finally {
    if (lockHeld) {
      try {
        await dedicated.$queryRaw`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY}::bigint)`;
      } catch (err) {
        log.warn(
          { kind: 'sys', event: 'lobby_ranking.unlock_failed', err },
          '释放排序刷新 advisory lock 失败'
        );
      }
      try {
        await dedicated.$queryRaw`SELECT set_config('statement_timeout', '120000', false)`;
      } catch {
        // 即将 disconnect；复位失败可忽略
      }
    }

    isRunning = false;

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
