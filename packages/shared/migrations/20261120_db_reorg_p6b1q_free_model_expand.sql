-- Domain: admin（运营托管配置的写入校验）——数据库重组阶段 6b-1q 扩展：退役"免费模型"前先放宽两个校验。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6b-1q）。
--
-- 用户 11-20 定退役角色卡免费额度；目录里 0 个免费模型，免费聊天由畅聊承担，所以"免费模型"整个概念一起退。
-- 新代码不再写模型目录的 is_free 和定价的 fixedDeduction.freeQuotaExhausted，但两个校验函数现在要求它们必须存在：
--   - admin.validate_model_catalog_prd：每个模型的 is_free 必须是布尔；
--   - admin.validate_fixed_llm_deduction_config：freeQuotaExhausted 必须是非负数。
-- 本文件（代码发布前执行，与现有代码兼容）：两处改为"可以不带；带了仍按原规则校验"。
--   守卫生产原文 md5（目录校验函数存的是 \r\n 换行），每处恰好替换一次，核对结果 md5；已是新版本跳过。
--   然后自检：当前生产配置照样通过；去掉这两个字段后也通过；is_free 不是布尔仍被拒。
-- 额度表、函数与两个配置 key 的删除在后端发布后的收缩文件里。
--
-- Verify: bash scripts/test-db-reorg-p6b1q-free-model-expand.sh
-- Release: TEST -> Production（不需要后端发布；先于退役代码发布）。

DO $patch$
DECLARE
  r record;
  v_md5 text;
  v_def text;
  v_done int := 0;
BEGIN
  SET LOCAL lock_timeout = '5s';
  FOR r IN SELECT * FROM (VALUES
    ('admin.validate_model_catalog_prd(jsonb)', 'f0afd5fcef7d2222759de9dec2e8a1d4', '8972ef63bed8d90960ad8ea56a219995',
     ARRAY[E'      OR jsonb_typeof(model -> ''is_free'') IS DISTINCT FROM ''boolean''\r\n'],
     ARRAY[E'      OR (model ? ''is_free'' AND jsonb_typeof(model -> ''is_free'') IS DISTINCT FROM ''boolean'')\r\n']),
    ('admin.validate_fixed_llm_deduction_config(jsonb)', 'af932ea8af0a02e9097cf766c64bc588', 'dfb67c2f26afa5b1af2f8d085f5127fd',
     ARRAY[E'     OR jsonb_typeof(p_value -> ''fixedDeduction'' -> ''freeQuotaExhausted'')\n        IS DISTINCT FROM ''number''\n',
           E'     OR (p_value #>> ''{fixedDeduction,freeQuotaExhausted}'')::NUMERIC < 0\n',
           E'''llm_pricing_config.fixedDeduction must include nonnegative freeQuotaExhausted, light, standard and premium amounts'''],
     ARRAY[E'     OR (p_value -> ''fixedDeduction'' ? ''freeQuotaExhausted''\n         AND jsonb_typeof(p_value -> ''fixedDeduction'' -> ''freeQuotaExhausted'') IS DISTINCT FROM ''number'')\n',
           E'     OR COALESCE((p_value #>> ''{fixedDeduction,freeQuotaExhausted}'')::NUMERIC, 0) < 0\n',
           E'''llm_pricing_config.fixedDeduction must include nonnegative light, standard and premium amounts'''])
  ) AS t(fn, old_md5, new_md5, olds, news) LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 = r.new_md5 THEN
      CONTINUE;
    ELSIF v_md5 <> r.old_md5 THEN
      RAISE EXCEPTION 'p6b1q-expand: % drifted (md5 %), refusing', r.fn, v_md5;
    END IF;
    v_def := pg_get_functiondef(r.fn::regprocedure);
    FOR i IN 1 .. array_length(r.olds, 1) LOOP
      IF (length(v_def) - length(replace(v_def, r.olds[i], ''))) / length(r.olds[i]) <> 1 THEN
        RAISE EXCEPTION 'p6b1q-expand: anchor % not found exactly once in %', i, r.fn;
      END IF;
      v_def := replace(v_def, r.olds[i], r.news[i]);
    END LOOP;
    EXECUTE v_def;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION 'p6b1q-expand: unexpected md5 % for %', v_md5, r.fn;
    END IF;
    v_done := v_done + 1;
  END LOOP;
  RAISE NOTICE 'p6b1q-expand: % validators now accept configs without is_free / freeQuotaExhausted', v_done;
END
$patch$;

DO $check$
DECLARE
  v_catalog jsonb;
  v_pricing jsonb;
  v_stripped jsonb;
  v_rejected boolean := false;
BEGIN
  SELECT value INTO v_catalog FROM app_core.runtime_config WHERE key = 'llm_model_catalog';
  SELECT value INTO v_pricing FROM app_core.runtime_config WHERE key = 'llm_pricing_config';
  IF v_catalog IS NOT NULL THEN
    PERFORM admin.validate_model_catalog_prd(v_catalog);
    SELECT jsonb_set(v_catalog, '{tiers}', COALESCE(jsonb_agg(
             jsonb_set(t.tier, '{models}', (
               SELECT COALESCE(jsonb_agg(m.model - 'is_free' ORDER BY m.ord), '[]'::jsonb)
               FROM jsonb_array_elements(t.tier -> 'models') WITH ORDINALITY AS m(model, ord)))
             ORDER BY t.ord), '[]'::jsonb))
      INTO v_stripped
    FROM jsonb_array_elements(v_catalog -> 'tiers') WITH ORDINALITY AS t(tier, ord);
    PERFORM admin.validate_model_catalog_prd(v_stripped);
    BEGIN
      PERFORM admin.validate_model_catalog_prd(jsonb_set(v_catalog, '{tiers,0,models,0,is_free}', '"yes"'));
    EXCEPTION WHEN invalid_parameter_value THEN
      v_rejected := true;
    END;
    IF NOT v_rejected THEN
      RAISE EXCEPTION 'p6b1q-expand: a non-boolean is_free is no longer rejected';
    END IF;
  END IF;
  IF v_pricing IS NOT NULL THEN
    PERFORM admin.validate_fixed_llm_deduction_config(v_pricing);
    PERFORM admin.validate_fixed_llm_deduction_config(v_pricing #- '{fixedDeduction,freeQuotaExhausted}');
  END IF;
  RAISE NOTICE 'p6b1q-expand: current configs and configs without the free-model fields both validate';
END
$check$;
