-- Domain: ops（上游模型调用）——出字后兜底：交付那一路怎么结束的 + 擦掉重写的兜底调用。
-- 设计见 .trellis/tasks/11-24-chat-recovery/design.md。
--
-- 本文件（扩展，后端发布前执行；不删任何东西，重跑安全）：
--   1. ops.llm_calls 加列 stream_end：交付给用户的那一路（首发/首字兜底胜出的行，以及 rewrite 行）出字后怎么结束的。
--      读者：按「平台 + 模型」聚合中断率 / 拒答率（含已被兜底救回的轮次——这些轮次 chat_history 记的是 success）。
--      值：completed 正常写完 / stalled 我方卡顿判定 / stream_error 流内错误块（如 Surplus stream_incomplete）/
--          content_filter / provider_error 其它非正常结束原因 / disconnected 没有 [DONE] 就断 / refused 我方拒答判定 /
--          cancelled 用户停止或执行截止 / output_cap 我方 5400 字上限 / length 供应商长度上限。
--   2. llm_calls_role_check 增加 rewrite（出字后中断或拒答，擦掉重写）：兜底调用各自一行，成本照常补。
-- 约束先 NOT VALID 再 VALIDATE，不长时间锁表。
--
-- Release: TEST -> Production -> 后端发布。迁移未执行时后端写这两处会失败，只记 warn，不影响对话与计费。
-- Recovery: 新列可保留；需要回退时
--   ALTER TABLE ops.llm_calls DROP CONSTRAINT llm_calls_stream_end_check, DROP COLUMN stream_end;
--   UPDATE ops.llm_calls SET role = 'fallback' WHERE role = 'rewrite';
--   再把 llm_calls_role_check 恢复为 role IS NULL OR role IN ('primary', 'fallback')。

SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE ops.llm_calls ADD COLUMN IF NOT EXISTS stream_end text;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'ops.llm_calls'::regclass AND conname = 'llm_calls_stream_end_check') THEN
    ALTER TABLE ops.llm_calls
      ADD CONSTRAINT llm_calls_stream_end_check CHECK (
        stream_end IS NULL OR stream_end IN (
          'completed', 'stalled', 'stream_error', 'content_filter', 'provider_error',
          'disconnected', 'refused', 'cancelled', 'output_cap', 'length'
        )
      ) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'ops.llm_calls'::regclass AND conname = 'llm_calls_role_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%rewrite%') THEN
    ALTER TABLE ops.llm_calls
      DROP CONSTRAINT llm_calls_role_check,
      ADD CONSTRAINT llm_calls_role_check
        CHECK (role IS NULL OR role IN ('primary', 'fallback', 'rewrite')) NOT VALID;
  END IF;
END
$constraints$;

ALTER TABLE ops.llm_calls VALIDATE CONSTRAINT llm_calls_stream_end_check;
ALTER TABLE ops.llm_calls VALIDATE CONSTRAINT llm_calls_role_check;

COMMENT ON COLUMN ops.llm_calls.stream_end IS
  '交付给用户的那一路出字后的结束方式（completed/stalled/stream_error/content_filter/provider_error/disconnected/refused/cancelled/output_cap/length）；写在首发/首字兜底胜出的行（end_reason = first_token_observed）与 rewrite 行';
COMMENT ON COLUMN ops.llm_calls.role IS
  'primary 首发 / fallback 首字兜底 / rewrite 出字后中断或拒答的擦掉重写';
