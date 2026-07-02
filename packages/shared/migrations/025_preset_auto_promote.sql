-- 025: 预设自动晋升触发器
--
-- 运营需求：在 st_platform.platform_presets 中 INSERT 一行 is_default=true 的预设时，
-- 自动完成以下操作，无需手动维护 platform_settings 指针：
--
--   1. 将旧默认预设 is_default 置为 false 且 enabled 置为 false
--   2. 复制最新 platform_settings 行，更新 oai_settings.preset_settings_openai 指针
--   3. 递增 platform_version，计算 content_hash
--   4. 插入新的 platform_settings 行（append-only 原则不变）
--
-- 决策依据：
--   - platform_presets 和 platform_settings 都是快照式 append-only
--   - 指针更新 = 新增一行 platform_settings（platform_version + 1）
--   - 旧默认预设 enabled=false 以避免新用户收到废弃的预设文件
--   - content_hash 由触发器在 PG 内计算（pgcrypto sha256）
--
-- 运营操作：只需执行一条 INSERT —
--
--   INSERT INTO st_platform.platform_presets (display_name, preset_payload, is_default)
--   VALUES ('预设名称', '{ ... }'::jsonb, true);
--
-- 触发器自动处理其余一切。

-- pgcrypto 用于 sha256（Supabase 默认已有，此处做幂等保护）
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── 触发器函数 ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION st_platform.promote_default_preset()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  prev          RECORD;
  new_jsonb     JSONB;
  new_version   BIGINT;
  new_hash      TEXT;
  pointer_val   TEXT;
BEGIN
  -- 仅当新行标记为 is_default=true 时才执行
  IF NEW.is_default IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- ① 将旧默认预设降级：is_default→false, enabled→false
  UPDATE st_platform.platform_presets
     SET is_default = false,
         enabled    = false,
         updated_at = now()
   WHERE is_default = true
     AND id IS DISTINCT FROM NEW.id;

  -- ② 取最新一行 platform_settings 作为基底
  SELECT platform_version, settings_jsonb, writable_paths
    INTO prev
    FROM st_platform.platform_settings
   ORDER BY platform_version DESC
   LIMIT 1;

  -- 首次初始化前 platform_settings 为空（不应出现在生产），跳过
  IF prev IS NULL THEN
    RETURN NEW;
  END IF;

  -- ③ 构造新 settings_jsonb：更新 preset 指针
  pointer_val := 'platform_' || NEW.id::text;
  new_jsonb   := jsonb_set(
    prev.settings_jsonb,
    '{oai_settings,preset_settings_openai}',
    to_jsonb(pointer_val)
  );

  -- ④ 版本号 +1
  new_version := prev.platform_version + 1;

  -- ⑤ 计算 content_hash（sha256）
  --    输入与应用层 canonicalize 的键集相同（platform_version, settings_jsonb, writable_paths），
  --    序列化方式为 PG jsonb::text（键天然去重），足以保证唯一性。
  new_hash := encode(
    digest(
      jsonb_build_object(
        'platform_version', new_version,
        'settings_jsonb',   new_jsonb,
        'writable_paths',   prev.writable_paths
      )::text,
      'sha256'
    ),
    'hex'
  );

  -- ⑥ 插入新 platform_settings 行（append-only）
  INSERT INTO st_platform.platform_settings (
    platform_version, settings_jsonb, writable_paths,
    content_hash, created_by, note
  ) VALUES (
    new_version,
    new_jsonb,
    prev.writable_paths,
    new_hash,
    'trigger:promote_default_preset',
    '自动晋升预设 ' || NEW.display_name || ' (' || NEW.id::text || ')'
  );

  RETURN NEW;
END;
$$;

-- ─── 触发器 ──────────────────────────────────────────────────────────────────────
-- BEFORE INSERT：在行真正插入前完成降级 + settings 追加，
-- 这样 idx_platform_presets_one_default 唯一约束检查时旧行已降级，不会冲突。

DROP TRIGGER IF EXISTS trg_preset_auto_promote
  ON st_platform.platform_presets;

CREATE TRIGGER trg_preset_auto_promote
  BEFORE INSERT ON st_platform.platform_presets
  FOR EACH ROW
  WHEN (NEW.is_default = true)
  EXECUTE FUNCTION st_platform.promote_default_preset();

-- ─── 注释 ────────────────────────────────────────────────────────────────────────
COMMENT ON FUNCTION st_platform.promote_default_preset() IS
  '预设自动晋升：INSERT is_default=true 的预设时，自动降级旧默认、'
  '追加新版 platform_settings 并更新 preset_settings_openai 指针。'
  '运营只需一条 INSERT 即可完成预设更新。';
