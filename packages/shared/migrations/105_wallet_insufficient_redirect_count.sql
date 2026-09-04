-- 105: 钱包表记录「星尘不足被拦」次数
--
-- 用户在两个入口会因余额不足被 402 拦下并被前端送去充值页：
--   · 聊天/重生成的余额预检（features/generation/precheck.ts，错误码 insufficient_balance）
--   · 切换付费模型的余额闸门（routes/models.ts，错误码 INSUFFICIENT_CREDITS）
-- 这个次数此前只在日志里（llm.balance.insufficient / models.select.blocked_insufficient），
-- 无法按用户一条 SQL 查出来。本迁移把计数落到钱包行上，由后端在返回 402 的两处调用自增。
--
-- 自增走 RPC 而不是客户端 update：Supabase JS 客户端不支持 SET x = x + 1 表达式，
-- 读改写在并发下会丢计数；钱包的其他写操作也都走 RPC，保持一致。
-- 应用侧会 await 这次自增再返回 402；PostgREST 缓存未刷新时再走 Prisma SQL 兜底。
--
-- 双 schema 兼容：与 100 / 103 同一套探测方式。production 尚未执行 099，
-- user_wallets 在 miniapp；test 已执行 099，在 billing。只改实际存在的那一套。

DO $migration$
DECLARE
  target_schema TEXT;
BEGIN
  IF to_regclass('billing.user_wallets') IS NOT NULL THEN
    target_schema := 'billing';
  ELSIF to_regclass('miniapp.user_wallets') IS NOT NULL THEN
    target_schema := 'miniapp';
  ELSE
    RAISE EXCEPTION '105: user_wallets 不在 billing 也不在 miniapp';
  END IF;

  EXECUTE format(
    'ALTER TABLE %I.user_wallets
       ADD COLUMN IF NOT EXISTS insufficient_balance_redirect_count INTEGER NOT NULL DEFAULT 0',
    target_schema
  );

  EXECUTE format(
    'ALTER TABLE %I.user_wallets
       ADD COLUMN IF NOT EXISTS first_insufficient_balance_redirect_at TIMESTAMPTZ DEFAULT NULL',
    target_schema
  );

  -- 钱包行可能还不存在（理论上调用方都先 getOrCreate 过，这里兜底），
  -- 所以用 INSERT ... ON CONFLICT 而不是裸 UPDATE。
  EXECUTE format(
    $fn$
CREATE OR REPLACE FUNCTION %1$I.increment_insufficient_balance_redirect(
  p_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $body$
BEGIN
  INSERT INTO %1$I.user_wallets (user_id, insufficient_balance_redirect_count, first_insufficient_balance_redirect_at, updated_at)
  VALUES (p_user_id, 1, now(), now())
  ON CONFLICT (user_id) DO UPDATE
  SET
    insufficient_balance_redirect_count =
      %1$I.user_wallets.insufficient_balance_redirect_count + 1,
    first_insufficient_balance_redirect_at =
      COALESCE(%1$I.user_wallets.first_insufficient_balance_redirect_at, now()),
    updated_at = now();
END;
$body$
    $fn$,
    target_schema
  );

  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION %I.increment_insufficient_balance_redirect(UUID)
       TO service_role, postgres',
    target_schema
  );

  EXECUTE format(
    'COMMENT ON COLUMN %I.user_wallets.insufficient_balance_redirect_count IS
       ''因星尘不足被 402 拦下（前端随即跳充值页）的累计次数。
         聊天预检与付费模型切换两个入口都计入。''',
    target_schema
  );

  EXECUTE format(
    'COMMENT ON COLUMN %I.user_wallets.first_insufficient_balance_redirect_at IS
       ''首次因星尘不足被 402 拦下的时间戳。未曾被拦截的用户为 NULL。''',
    target_schema
  );

  EXECUTE format(
    'COMMENT ON FUNCTION %I.increment_insufficient_balance_redirect(UUID) IS
       ''余额不足拦截计数 +1。后端在返回 402 前 await 调用，失败不影响业务。''',
    target_schema
  );
END
$migration$;

-- 新函数要进 PostgREST 的 rpc 暴露列表，让它重载缓存。
NOTIFY pgrst, 'reload schema';
