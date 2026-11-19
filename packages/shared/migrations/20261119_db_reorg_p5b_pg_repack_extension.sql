-- Domain: 运维（数据库维护）——数据库重组阶段 5b 第三步前置：安装 pg_repack 扩展。
-- 计划见 .trellis/tasks/11-19-db-reorg-p5-chat-history/design.md（5b）。
--
-- 第二步删掉 experience.chat_history.history 后，旧值仍占 TOAST 约 23GB，直到整表重写。VACUUM FULL / CLUSTER
-- 会锁表把约 1.5GB 有效数据读写一遍（回复正文分散在 23GB TOAST 里），可能锁数分钟；pg_repack 只在开头和换表时
-- 短暂加锁，复制期间读写照常。Supabase 官方支持（postgres 可建，客户端带 -k）；本库可装版本 1.5.2，
-- Database Migration workflow 的 repack 模式用从 tag ver_1.5.2 编译的同版本客户端执行。
-- 扩展只建 repack schema 与其函数，不动业务表。版本不是 1.5.2 时拒绝且不建（客户端必须与之完全一致）。
--
-- Verify: 本地演练（scripts/rehearse-pg-repack.sh：编译 1.5.2、建扩展、非超级用户 -k 重写带删除列的表，期间并发写入）。
-- Release: TEST -> Production，然后 workflow mode=repack（先 TEST）。
-- Recovery: DROP EXTENSION pg_repack CASCADE（也会清掉中断的 repack 留下的触发器与日志表）。

DO $pg_repack$
DECLARE
  v_available text;
  v_installed text;
BEGIN
  SELECT extversion INTO v_installed FROM pg_extension WHERE extname = 'pg_repack';
  IF v_installed IS NULL THEN
    SELECT default_version INTO v_available FROM pg_available_extensions WHERE name = 'pg_repack';
    IF v_available IS DISTINCT FROM '1.5.2' THEN
      RAISE EXCEPTION 'pg_repack 1.5.2 is required, available: %', COALESCE(v_available, 'none');
    END IF;
    EXECUTE 'CREATE EXTENSION pg_repack';
    SELECT extversion INTO v_installed FROM pg_extension WHERE extname = 'pg_repack';
  END IF;
  IF v_installed IS DISTINCT FROM '1.5.2' THEN
    RAISE EXCEPTION 'pg_repack % is installed, 1.5.2 is required', v_installed;
  END IF;
  RAISE NOTICE 'pg_repack % ready', v_installed;
END
$pg_repack$;
