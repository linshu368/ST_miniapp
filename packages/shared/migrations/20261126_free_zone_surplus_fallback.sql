-- domain: experience
-- 畅聊专用兜底（Surplus deepseek-v4.1-flash-1017）：让首字兜底的调用意图与交付选择支持 Surplus 兜底。
-- 计划见 .trellis/tasks/11-26-free-zone-pin-fallback/design.md（PR2）。
--
-- 真实故障（不改就一定失败）：
--   - prepare_chat_generation_fallback 写死 provider='openrouter'，Surplus 兜底之后观测时
--     observe_chat_generation_attempt 报 'Attempt route cannot be rebound'；
--   - select_chat_generation_delivery 遇到 Surplus 交付一律调 record_surplusintelligence_call，
--     把兜底的 generation_id 写进每轮那一行（属于首发的）Surplus 调用记录：身份冲突则交付失败，否则张冠李戴；
--     首发不是 Surplus（目录免费模型）时那一行不存在，STRICT 直接报错。
--
-- 本文件：
--   1) 新增重载 experience.prepare_chat_generation_fallback(uuid,uuid,numeric,text)：兜底 provider 由调用方给，
--      只收 openrouter / surplus，其余与三参版本（2026-11-26 生产实测 md5 48d77c3a…）一致。三参版本不动：
--      付费兜底继续调它，滚动发布期间旧进程也照常可用；收缩时再删。
--   2) 补丁 experience.select_chat_generation_delivery：Surplus 分支只在交付的是首发（role='primary'）时写那一行。
--      锚点必须恰好一处（2026-11-26 生产实测一处，md5 392e0acf…），已补过跳过；CREATE OR REPLACE 保留原 ACL。
-- 不改表、不写数据。新函数 ACL 与原函数一致（只 service_role）。
--
-- Verify: bash scripts/test-free-zone-surplus-fallback-migration.sh
-- Release: TEST -> Production，先于读写它的后端发布（后端只在兜底是 Surplus 时调四参版本）。
-- Rollback（先回退后端或把 free_zone_config.fallback 置空）：
--   DROP FUNCTION experience.prepare_chat_generation_fallback(uuid,uuid,numeric,text);
--   交付函数把 `IF a.role='primary' THEN … END IF;` 还原成原来那一句 PERFORM（同样用锚点替换）。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION experience.prepare_chat_generation_fallback(
  p_history_id uuid, p_attempt_id uuid, p_triggered_ms numeric, p_provider text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE r experience.chat_generation_requests%ROWTYPE; existing_id uuid;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('openrouter','surplus') THEN
    RAISE EXCEPTION 'Unsupported fallback provider' USING ERRCODE='22023';
  END IF;
  -- Same as the three-argument version except the provider. Keep the established lock order.
  -- This RPC records a scheduled attempt, never permission to call a model.
  PERFORM 1 FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  SELECT * INTO STRICT r FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id FOR UPDATE;
  IF p_attempt_id IS NULL OR p_triggered_ms IS NULL OR p_triggered_ms<0
     OR p_triggered_ms>=r.first_token_deadline_ms THEN
    RAISE EXCEPTION 'Fallback dispatch was outside the frozen first-token budget' USING ERRCODE='22023';
  END IF;
  SELECT id INTO existing_id FROM experience.chat_generation_attempts WHERE chat_history_id=p_history_id AND role='fallback';
  IF existing_id IS NOT NULL THEN
    IF existing_id=p_attempt_id THEN RETURN; END IF;
    RAISE EXCEPTION 'Fallback attempt identity conflict' USING ERRCODE='PT409';
  END IF;
  UPDATE experience.chat_generation_requests SET fallback_triggered_ms=COALESCE(fallback_triggered_ms,p_triggered_ms) WHERE chat_history_id=p_history_id;
  INSERT INTO experience.chat_generation_attempts(id,chat_history_id,role,provider,provider_model_id)
  VALUES(p_attempt_id,p_history_id,'fallback',p_provider,r.fallback_model_id);
END;
$function$;

REVOKE ALL ON FUNCTION experience.prepare_chat_generation_fallback(uuid,uuid,numeric,text) FROM PUBLIC;
DO $acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION experience.prepare_chat_generation_fallback(uuid,uuid,numeric,text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION experience.prepare_chat_generation_fallback(uuid,uuid,numeric,text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION experience.prepare_chat_generation_fallback(uuid,uuid,numeric,text) TO service_role;
  END IF;
END
$acl$;

DO $delivery$
DECLARE
  fn regprocedure := 'experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure;
  d text;
  anchor text := $a$    PERFORM experience.record_surplusintelligence_call(p_history_id,jsonb_build_object('generation_id',COALESCE(p_generation_id,a.generation_id)));$a$;
  replacement text := $r$    -- 2026-11-26: the per-turn Surplus call row belongs to the primary; a Surplus fallback winner leaves it alone.
    IF a.role='primary' THEN
      PERFORM experience.record_surplusintelligence_call(p_history_id,jsonb_build_object('generation_id',COALESCE(p_generation_id,a.generation_id)));
    END IF;$r$;
BEGIN
  d := replace(pg_get_functiondef(fn), E'\r\n', E'\n');
  IF position('IF a.role=''primary'' THEN' IN d) > 0 THEN
    RAISE NOTICE 'free_zone_surplus_fallback: delivery already patched, skipped';
    RETURN;
  END IF;
  IF (length(d) - length(replace(d, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'free_zone_surplus_fallback: delivery anchor not found exactly once, refusing';
  END IF;
  EXECUTE replace(d, anchor, replacement);
  RAISE NOTICE 'free_zone_surplus_fallback: delivery patched';
END
$delivery$;

COMMIT;
