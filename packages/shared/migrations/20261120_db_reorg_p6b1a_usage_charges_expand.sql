-- Domain: billing（文本扣费）——数据库重组阶段 6b-1a：建 billing.usage_charges，回填文本扣费，镜像过渡。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6b-1 定稿草案、6b-1a 详细方案）。
--
-- 文本一轮 = usage_charges 一行（kind = chat_text，id = llm_charge_id）。本步只"扩展"：
--   1. 建表（RLS 开、只给 service_role；user_id / debit_ledger_id 外键沿用 billing 惯例；subject_id 软引用，
--      没有对应轮次的旧扣费记录为空）。
--   2. 镜像触发器（同事务）：
--      - billing.llm_usage_charges AFTER INSERT/UPDATE → 扣费字段（状态、实扣、流水 id、generation_id、quote.charge）；
--      - experience.chat_history AFTER INSERT/UPDATE OF 计费列 → 报价快照、应扣、结算时间；
--        没有扣费记录的轮次由它决定状态（未结算 quoted，已结算按轮次状态 free / failed）。
--      不镜像删除："每用户留 100 条"的删除不影响新表。三个写入函数（charge / reconcile / refund）原样不动。
--   3. 回填全部历史（轮次 + 扣费记录 + 去重表 + 流水 id），与镜像写入冲突时以已有值为准。
--   4. 自检：每一轮新表实扣 = chat_history.deduction_rate；扣费记录、去重表的每个 key 在新表都有行。
-- 读方切换（6b-1b）与旧表、旧列删除（6b-1c）在后续步骤。
--
-- Verify: bash scripts/test-db-reorg-p6b1a-usage-charges.sh
-- Release: TEST -> Production（不需要后端发布）。

-- 前置守卫（什么都不建之前）：源数据一致——扣费记录 / 去重表的金额与 chat_history.deduction_rate 一致（不看最近 10 分钟的进行中轮次）
DO $guard$
DECLARE
  v_bad bigint;
BEGIN
  IF to_regclass('billing.usage_charges') IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_bad
  FROM experience.chat_history h
  LEFT JOIN billing.llm_usage_charges c ON c.charge_key = h.llm_charge_id
  LEFT JOIN billing.llm_usage_charge_dedup d ON d.charge_key = h.llm_charge_id
  WHERE h.llm_charge_id IS NOT NULL AND h.created_at < now() - interval '10 minutes'
    AND COALESCE(c.charged_amount, d.charged_amount, h.deduction_rate, 0) IS DISTINCT FROM COALESCE(h.deduction_rate, 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'p6b1a: % turns have charge amount != deduction_rate; refusing to create usage_charges', v_bad;
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS billing.usage_charges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('chat_text', 'chat_voice', 'plaza_image', 'plaza_video')),
  subject_id uuid,
  status text NOT NULL CHECK (status IN ('quoted', 'reserved', 'pending', 'charged', 'free', 'failed', 'waived', 'refunded',
                                         'partial', 'reconciled', 'historical')),
  billing_mode text,
  wallet_policy text,
  quoted_credits numeric(14,1),
  charged_credits numeric(14,1) NOT NULL DEFAULT 0,
  debit_ledger_id uuid REFERENCES billing.wallet_ledger(id),
  refund_ledger_id uuid REFERENCES billing.wallet_ledger(id),
  generation_id text,
  quote jsonb NOT NULL DEFAULT '{}'::jsonb,
  quote_expires_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE billing.usage_charges IS
  '每次计费一行（文本轮次 / 语音 / 广场）。id 即 charge_id；quote 冻结报价与扣费明细；永久保留。6b-1a 起文本经镜像触发器写入。';
ALTER TABLE billing.usage_charges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing.usage_charges FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.usage_charges TO service_role;

-- 镜像：扣费记录 → 新表（扣费字段）
CREATE OR REPLACE FUNCTION billing.tf_mirror_llm_usage_charge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  INSERT INTO billing.usage_charges AS u
    (id, user_id, kind, status, charged_credits, debit_ledger_id, generation_id, billing_mode, quote, created_at, updated_at)
  VALUES (
    NEW.charge_key, NEW.user_id, 'chat_text', NEW.status, NEW.charged_amount, NEW.debit_ledger_id, NEW.generation_id,
    NEW.metadata ->> 'billing_mode',
    jsonb_build_object('charge', jsonb_build_object(
      'model_id', NEW.model_id, 'model_openrouter_id', NEW.model_openrouter_id, 'model_display_name', NEW.model_display_name,
      'catalog_version', NEW.catalog_version, 'pricing_config_version', NEW.pricing_config_version,
      'exchange_rate', NEW.exchange_rate, 'model_markup', NEW.model_markup, 'initial_amount', NEW.initial_amount,
      'calculated_amount', NEW.calculated_amount, 'fallback_used', NEW.fallback_used, 'metadata', NEW.metadata,
      'reconciled_at', NEW.reconciled_at)),
    NEW.created_at, now())
  ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    charged_credits = EXCLUDED.charged_credits,
    debit_ledger_id = EXCLUDED.debit_ledger_id,
    generation_id = COALESCE(EXCLUDED.generation_id, u.generation_id),
    billing_mode = COALESCE(EXCLUDED.billing_mode, u.billing_mode),
    quote = u.quote || EXCLUDED.quote,
    updated_at = now();
  RETURN NULL;
END
$fn$;

-- 镜像：轮次 → 新表（报价快照、应扣、结算时间；没有扣费记录时决定状态与实扣）
CREATE OR REPLACE FUNCTION billing.tf_mirror_chat_history_charge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_status text := CASE
    WHEN NEW.llm_billing_settled_at IS NULL THEN 'quoted'
    WHEN NEW.status = 'success' THEN 'free'
    ELSE 'failed'
  END;
BEGIN
  INSERT INTO billing.usage_charges AS u
    (id, user_id, kind, subject_id, status, quoted_credits, charged_credits, quote, settled_at, created_at, updated_at)
  VALUES (
    NEW.llm_charge_id, NEW.user_id, 'chat_text', NEW.id, v_status, NEW.llm_intended_deduction, COALESCE(NEW.deduction_rate, 0),
    jsonb_strip_nulls(jsonb_build_object('snapshot', NEW.llm_billing_snapshot)), NEW.llm_billing_settled_at, NEW.created_at, now())
  ON CONFLICT (id) DO UPDATE SET
    subject_id = COALESCE(u.subject_id, EXCLUDED.subject_id),
    quoted_credits = COALESCE(EXCLUDED.quoted_credits, u.quoted_credits),
    -- 有扣费记录的行，状态与实扣以扣费记录为准；没有的由轮次决定
    status = CASE WHEN u.quote ? 'charge' THEN u.status ELSE EXCLUDED.status END,
    charged_credits = CASE WHEN u.quote ? 'charge' THEN u.charged_credits ELSE EXCLUDED.charged_credits END,
    quote = u.quote || EXCLUDED.quote,
    settled_at = COALESCE(EXCLUDED.settled_at, u.settled_at),
    updated_at = now();
  RETURN NULL;
END
$fn$;

DO $triggers$
BEGIN
  SET LOCAL lock_timeout = '5s';
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_mirror_llm_usage_charge'
                 AND tgrelid = 'billing.llm_usage_charges'::regclass) THEN
    CREATE TRIGGER trg_mirror_llm_usage_charge AFTER INSERT OR UPDATE ON billing.llm_usage_charges
      FOR EACH ROW EXECUTE FUNCTION billing.tf_mirror_llm_usage_charge();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_mirror_chat_history_charge'
                 AND tgrelid = 'experience.chat_history'::regclass) THEN
    CREATE TRIGGER trg_mirror_chat_history_charge
      AFTER INSERT OR UPDATE OF llm_charge_id, llm_billing_snapshot, deduction_rate, llm_intended_deduction, llm_billing_settled_at
      ON experience.chat_history
      FOR EACH ROW WHEN (NEW.llm_charge_id IS NOT NULL) EXECUTE FUNCTION billing.tf_mirror_chat_history_charge();
  END IF;
  RAISE NOTICE 'p6b1a: mirror triggers installed';
END
$triggers$;

-- 回填：按轮次时间分窗，每窗一条语句（经事务池自动提交），避免长事务让进行中轮次的镜像写入等锁。
-- 冲突时只补空值（镜像已写的值更新）。临时函数用完即删。
CREATE OR REPLACE FUNCTION billing.p6b1a_backfill_turns(p_from timestamptz, p_to timestamptz)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_rows bigint;
BEGIN
  -- 1) 有轮次的：轮次 + 扣费记录 + 去重表 + 流水
  INSERT INTO billing.usage_charges AS u
    (id, user_id, kind, subject_id, status, billing_mode, quoted_credits, charged_credits, debit_ledger_id, generation_id,
     quote, settled_at, created_at, updated_at)
  SELECT h.llm_charge_id, h.user_id, 'chat_text', h.id,
    CASE
      WHEN c.charge_key IS NOT NULL THEN c.status
      WHEN d.charge_key IS NOT NULL THEN d.status
      WHEN h.llm_billing_settled_at IS NULL AND h.created_at > now() - interval '1 day' THEN 'quoted'
      WHEN h.status = 'success' THEN 'free'
      ELSE 'failed'
    END,
    c.metadata ->> 'billing_mode',
    h.llm_intended_deduction,
    COALESCE(c.charged_amount, d.charged_amount, h.deduction_rate, 0),
    COALESCE(c.debit_ledger_id, l.id),
    COALESCE(c.generation_id, d.generation_id),
    jsonb_strip_nulls(jsonb_build_object(
      'snapshot', h.llm_billing_snapshot,
      'charge', CASE WHEN c.charge_key IS NULL THEN NULL ELSE jsonb_build_object(
        'model_id', c.model_id, 'model_openrouter_id', c.model_openrouter_id, 'model_display_name', c.model_display_name,
        'catalog_version', c.catalog_version, 'pricing_config_version', c.pricing_config_version,
        'exchange_rate', c.exchange_rate, 'model_markup', c.model_markup, 'initial_amount', c.initial_amount,
        'calculated_amount', c.calculated_amount, 'fallback_used', c.fallback_used, 'metadata', c.metadata,
        'reconciled_at', c.reconciled_at) END,
      'legacy', CASE
        WHEN c.charge_key IS NULL AND d.charge_key IS NOT NULL THEN 'dedup_only'
        WHEN c.charge_key IS NULL AND d.charge_key IS NULL AND h.llm_billing_settled_at IS NULL
             AND h.created_at <= now() - interval '1 day' THEN 'unsettled_no_charge'
      END)),
    h.llm_billing_settled_at, h.created_at, now()
  FROM experience.chat_history h
  LEFT JOIN billing.llm_usage_charges c ON c.charge_key = h.llm_charge_id
  LEFT JOIN billing.llm_usage_charge_dedup d ON d.charge_key = h.llm_charge_id
  LEFT JOIN (
    SELECT DISTINCT ON (wl.reference_id) wl.reference_id, wl.id FROM billing.wallet_ledger wl
    WHERE wl.reference_type = 'llm_usage' AND wl.entry_type = 'chat_debit'
    ORDER BY wl.reference_id, wl.created_at) l ON c.charge_key IS NULL AND l.reference_id = h.llm_charge_id::text
  WHERE h.llm_charge_id IS NOT NULL AND h.created_at >= p_from AND h.created_at < p_to
  ON CONFLICT (id) DO UPDATE SET
    subject_id = COALESCE(u.subject_id, EXCLUDED.subject_id),
    quoted_credits = COALESCE(u.quoted_credits, EXCLUDED.quoted_credits),
    debit_ledger_id = COALESCE(u.debit_ledger_id, EXCLUDED.debit_ledger_id),
    generation_id = COALESCE(u.generation_id, EXCLUDED.generation_id),
    billing_mode = COALESCE(u.billing_mode, EXCLUDED.billing_mode),
    quote = EXCLUDED.quote || u.quote,
    settled_at = COALESCE(u.settled_at, EXCLUDED.settled_at);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$fn$;

SELECT billing.p6b1a_backfill_turns('-infinity', '2026-08-15 00:00+08');
SELECT billing.p6b1a_backfill_turns('2026-08-15 00:00+08', '2026-09-15 00:00+08');
SELECT billing.p6b1a_backfill_turns('2026-09-15 00:00+08', '2026-10-15 00:00+08');
SELECT billing.p6b1a_backfill_turns('2026-10-15 00:00+08', '2026-11-01 00:00+08');
SELECT billing.p6b1a_backfill_turns('2026-11-01 00:00+08', '2026-11-10 00:00+08');
SELECT billing.p6b1a_backfill_turns('2026-11-10 00:00+08', '2026-11-16 00:00+08');
SELECT billing.p6b1a_backfill_turns('2026-11-16 00:00+08', now() - interval '1 hour');
SELECT billing.p6b1a_backfill_turns(now() - interval '1 hour', 'infinity');
DROP FUNCTION billing.p6b1a_backfill_turns(timestamptz, timestamptz);

DO $orphans$
DECLARE
  v_charges bigint;
  v_dedup bigint;
BEGIN
  -- 2) 没有对应轮次的扣费记录（消费记录会展示）
  INSERT INTO billing.usage_charges AS u
    (id, user_id, kind, status, billing_mode, charged_credits, debit_ledger_id, generation_id, quote, created_at, updated_at)
  SELECT c.charge_key, c.user_id, 'chat_text', c.status, c.metadata ->> 'billing_mode', c.charged_amount, c.debit_ledger_id, c.generation_id,
    jsonb_build_object('charge', jsonb_build_object(
      'model_id', c.model_id, 'model_openrouter_id', c.model_openrouter_id, 'model_display_name', c.model_display_name,
      'catalog_version', c.catalog_version, 'pricing_config_version', c.pricing_config_version,
      'exchange_rate', c.exchange_rate, 'model_markup', c.model_markup, 'initial_amount', c.initial_amount,
      'calculated_amount', c.calculated_amount, 'fallback_used', c.fallback_used, 'metadata', c.metadata,
      'reconciled_at', c.reconciled_at), 'legacy', 'no_turn'),
    c.created_at, now()
  FROM billing.llm_usage_charges c
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_charges = ROW_COUNT;

  -- 3) 只在去重表、也没有对应轮次的 key（保住"已处理过不能再扣"）
  INSERT INTO billing.usage_charges AS u
    (id, user_id, kind, status, charged_credits, debit_ledger_id, generation_id, quote, created_at, updated_at)
  SELECT d.charge_key, d.user_id, 'chat_text', d.status, d.charged_amount, l.id, d.generation_id,
    jsonb_build_object('legacy', 'dedup_only_no_turn'), d.processed_at, now()
  FROM billing.llm_usage_charge_dedup d
  LEFT JOIN (
    SELECT DISTINCT ON (wl.reference_id) wl.reference_id, wl.id FROM billing.wallet_ledger wl
    WHERE wl.reference_type = 'llm_usage' AND wl.entry_type = 'chat_debit'
    ORDER BY wl.reference_id, wl.created_at) l ON l.reference_id = d.charge_key::text
  WHERE NOT EXISTS (SELECT 1 FROM billing.usage_charges x WHERE x.id = d.charge_key)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_dedup = ROW_COUNT;
  RAISE NOTICE 'p6b1a: orphan charges %, dedup-only keys %', v_charges, v_dedup;
END
$orphans$;

DO $check$
DECLARE
  v_bad_amount bigint;
  v_missing bigint;
  v_turns bigint;
BEGIN
  -- 自检
  SELECT count(*) INTO v_bad_amount
  FROM experience.chat_history h JOIN billing.usage_charges u ON u.id = h.llm_charge_id
  WHERE h.created_at < now() - interval '10 minutes' AND u.charged_credits IS DISTINCT FROM COALESCE(h.deduction_rate, 0);
  SELECT (SELECT count(*) FROM billing.llm_usage_charges c WHERE NOT EXISTS (SELECT 1 FROM billing.usage_charges u WHERE u.id = c.charge_key))
       + (SELECT count(*) FROM billing.llm_usage_charge_dedup d WHERE NOT EXISTS (SELECT 1 FROM billing.usage_charges u WHERE u.id = d.charge_key))
       + (SELECT count(*) FROM experience.chat_history h WHERE h.llm_charge_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM billing.usage_charges u WHERE u.id = h.llm_charge_id))
    INTO v_missing;
  IF v_bad_amount > 0 OR v_missing > 0 THEN
    RAISE EXCEPTION 'p6b1a: self-check failed (% turns with charged != deduction_rate, % keys missing)', v_bad_amount, v_missing;
  END IF;
  SELECT count(*) INTO v_turns FROM billing.usage_charges WHERE subject_id IS NOT NULL;
  RAISE NOTICE 'p6b1a: % turns in usage_charges; self-check ok', v_turns;
END
$check$;

CREATE INDEX IF NOT EXISTS usage_charges_user_created_idx ON billing.usage_charges (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_charges_subject_idx ON billing.usage_charges (kind, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_charges_generation_idx ON billing.usage_charges (generation_id) WHERE generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_charges_open_idx ON billing.usage_charges (created_at) WHERE status IN ('quoted', 'pending');
