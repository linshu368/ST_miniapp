-- domain: admin
-- 仅调整运营新建卡的取号。用户创作卡默认使用 2147483647，不参与运营卡取号。
-- 普通序号用尽时共用最后一档 2147483646；sort_order 允许并列。
-- 不回填数据。需回滚时，只恢复执行前的 admin.create_character 函数定义。
BEGIN;

DO $migration$
DECLARE
  definition text := pg_get_functiondef(
    'admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text)'::regprocedure
  );
  old_query constant text := $old$SELECT COALESCE(max(card.sort_order), -1) + 1 INTO v_next_order
  FROM app_core.characters AS card;$old$;
  new_query constant text := $new$SELECT LEAST(COALESCE(max(card.sort_order), -1) + 1, 2147483646) INTO v_next_order
  FROM app_core.characters AS card
  WHERE card.sort_order < 2147483647;$new$;
BEGIN
  IF strpos(definition, new_query) > 0 THEN
    RETURN;
  END IF;
  IF strpos(definition, old_query) = 0 THEN
    RAISE EXCEPTION 'Unexpected sort-order query in admin.create_character';
  END IF;
  EXECUTE replace(definition, old_query, new_query);
END
$migration$;

COMMIT;
