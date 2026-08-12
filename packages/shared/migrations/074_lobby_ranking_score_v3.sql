-- 首页「推荐」排序 v3 的数据支撑。
--
-- v2 的口径是「进入聊天去重用户数 ≥ 10 的卡按 5 轮转化率排序，前八运营固定」，
-- v3 换成两个指标的加权分，且前八不再豁免：
--   D30（权重 0.75）：80 天窗口内 AVG(LEAST(turns, 30)) / 30，衡量对话深度
--   R48（权重 0.25）：新客首次会话结束后 48 小时内是否回访，衡量留存
-- 两者都做贝叶斯收缩与百分位归一化，具体公式在 backend 的 features/lobby/ranking-score.ts，
-- 本迁移只负责建汇总表与补索引，不在库里做统计。
--
-- 计算成本决定了它不能挂在读路径上：80 天窗口 + LAG 切会话是全表级扫描，
-- 所以由后端每日 job 算完写进这张表，大厅请求只读「每卡一行」。
--
-- 本迁移纯新增。v2 的 miniapp.character_engagement_stats 视图刻意保留不删——
-- v3 若需回滚，回退代码即可，不必动数据库。

BEGIN;

-- ── 1. 时间窗聚合所需索引 ────────────────────────────────────────────────────
-- 060 的 idx_chat_history_character_user_round 尾列是 user_character_round，
-- 走不了 v3 的 created_at 窗口过滤，需要单独一条。
CREATE INDEX IF NOT EXISTS idx_chat_history_character_user_created_at
  ON miniapp.chat_history (character_id, user_id, created_at)
  WHERE character_id IS NOT NULL;

-- ── 2. 排序分汇总表 ──────────────────────────────────────────────────────────
-- 每张角色卡一行。原始量（n_c / d30_raw / k_c / r48_raw）一并落库，
-- 便于事后复核某张卡为什么是这个分，不用重跑聚合。
CREATE TABLE IF NOT EXISTS miniapp.character_ranking_scores (
  character_id  UUID PRIMARY KEY
    REFERENCES miniapp.characters(id) ON DELETE CASCADE,
  -- 窗口内与该卡有过至少一轮对话的去重用户数。低于阈值的卡不进主池
  n_c           INTEGER          NOT NULL DEFAULT 0,
  -- AVG(LEAST(turns, 30)) / 30，取值 [0, 1]
  d30_raw       DOUBLE PRECISION,
  -- 对 d30_raw 做贝叶斯收缩后的值，排序标尺用的是它而不是 d30_raw
  d30_shrunk    DOUBLE PRECISION,
  -- R48 分母：窗口内首次会话已结束满 48 小时的新客数
  k_c           INTEGER          NOT NULL DEFAULT 0,
  -- 回访率原始值，k_c = 0 时为 NULL（无样本，与「回访率为 0」不是一回事）
  r48_raw       DOUBLE PRECISION,
  -- 最终排序分，0–100
  score         NUMERIC(6, 2)    NOT NULL DEFAULT 0,
  -- 留痕：口径调整后回看历史数据时需要知道当时的窗口宽度
  window_days   INTEGER          NOT NULL,
  computed_at   TIMESTAMPTZ      NOT NULL DEFAULT now()
);

COMMENT ON TABLE miniapp.character_ranking_scores IS
  '首页推荐排序 v3 的每卡评分快照，由后端每日 job 刷新；大厅读路径只读本表。';
COMMENT ON COLUMN miniapp.character_ranking_scores.n_c IS
  '统计窗口内与该卡有过至少一轮对话的去重用户数；低于阈值的卡进冷启动池而非主池。';
COMMENT ON COLUMN miniapp.character_ranking_scores.r48_raw IS
  '48 小时回访率原始值；k_c = 0 时为 NULL，表示无样本，不等同于回访率 0。';

-- 主池按 score 降序取数，覆盖索引避免回表。
CREATE INDEX IF NOT EXISTS idx_character_ranking_scores_score
  ON miniapp.character_ranking_scores (score DESC, character_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON miniapp.character_ranking_scores
  TO service_role, postgres;

COMMIT;

NOTIFY pgrst, 'reload schema';
