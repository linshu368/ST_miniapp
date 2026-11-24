-- Domain: admin（运营托管配置：登记 + 写入校验）
-- 设计：.trellis/tasks/11-23-memory-panel/design.md §4b。
--
-- 记忆栏 prompt 放运营平台（用户 11-23 定：内容上的限制写在 prompt 里由运营调整，不在代码里硬编码）：
--   1. admin.managed_config_keys 登记 memory_bar_prompt（纯文本，存 runtime_config.text_value）；
--   2. admin.validate_managed_config_value 原地加一个 WHEN 分支：只收文本、去空白后 1–12000 字
--      （与 shared MemoryBarPromptSchema 一致，按 UTF-16 计数）。做法同 CONTRACT §2.5：读现行定义，
--      在 story_memory_prompt 分支前插入，锚点必须恰好一处，对不上就拒绝执行；已加过的跳过。
-- 输出结构（JSON 字段与字数上限）由代码固定，不在这个 key 里。
-- 初稿由运营平台 CLI 发布（draft set → diff → publish），迁移不写配置值。
--
-- 执行：TEST → 生产（需确认）。无锁表、无数据变更。
-- 回滚：UPDATE admin.managed_config_keys SET retired_at = now() WHERE config_key = 'memory_bar_prompt';
--       分支留着无害（不再可编辑后不会被调用）；如需删分支，按 git 历史反向替换。
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO admin.managed_config_keys (config_key, managed_via, note)
VALUES ('memory_bar_prompt', 'operations_config', '记忆栏（右侧面板）prompt：纯文本；输出结构由代码固定')
ON CONFLICT (config_key) DO NOTHING;

DO $branch$
DECLARE
  v_proc constant regprocedure := 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure;
  v_anchor constant text := E'\n    WHEN ''story_memory_prompt'' THEN';
  v_branch constant text := E'\n    WHEN ''memory_bar_prompt'' THEN'
    || E'\n      v_text := btrim(p_text_value, U&''\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\3000\\FEFF'');'
    || E'\n      SELECT coalesce(sum(CASE WHEN ascii(glyph) > 65535 THEN 2 ELSE 1 END), 0)'
    || E'\n        INTO v_length FROM regexp_split_to_table(v_text, '''') AS glyph WHERE glyph <> '''';'
    || E'\n      IF p_value IS NOT NULL OR p_text_value IS NULL OR v_length = 0 OR v_length > 12000 THEN'
    || E'\n        RAISE EXCEPTION ''memory bar prompt requires text only, between 1 and 12000 characters'''
    || E'\n          USING ERRCODE = ''22023'';'
    || E'\n      END IF;'
    || E'\n';
  v_def text;
  v_hits integer;
BEGIN
  v_def := replace(pg_get_functiondef(v_proc), E'\r', '');
  IF position('''memory_bar_prompt''' IN v_def) > 0 THEN
    RETURN;  -- 已加过（重跑）
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'memory_bar_prompt: expected exactly one story_memory_prompt branch, found %; refusing to rewrite', v_hits;
  END IF;
  -- replace() 按字面替换（不用 regexp_replace：分支里的 \0009 会被当成反向引用）
  EXECUTE replace(v_def, v_anchor, v_branch || substr(v_anchor, 2));
END
$branch$;

-- 核对：合法文本通过，空白与 JSON 值都拒绝
DO $verify$
BEGIN
  PERFORM admin.validate_managed_config_value('memory_bar_prompt', NULL, '你是剧情记录员。');
  BEGIN
    PERFORM admin.validate_managed_config_value('memory_bar_prompt', NULL, U&'\3000 ');
    RAISE EXCEPTION 'memory_bar_prompt: blank text accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    PERFORM admin.validate_managed_config_value('memory_bar_prompt', '{}'::jsonb, NULL);
    RAISE EXCEPTION 'memory_bar_prompt: json value accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    PERFORM admin.validate_managed_config_value('memory_bar_prompt', NULL, repeat('记', 12001));
    RAISE EXCEPTION 'memory_bar_prompt: over-long text accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
END
$verify$;

COMMIT;
