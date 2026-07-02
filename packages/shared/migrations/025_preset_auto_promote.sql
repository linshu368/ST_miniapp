-- 025: 预设自动晋升触发器 + canonical JSON 序列化函数
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
--   - content_hash 使用 canonical_jsonb() 计算，与 JS 侧 hash.ts 的
--     canonicalize → JSON.stringify → sha256 产出完全一致的结果
--
-- 运营操作：只需执行一条 INSERT —
--
--   INSERT INTO st_platform.platform_presets (display_name, preset_payload, is_default)
--   VALUES ('预设名称', '{ ... }'::jsonb, true);
--
-- 触发器自动处理其余一切。

-- pgcrypto 用于 sha256（Supabase 默认已有，此处做幂等保护）
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── canonical JSON 序列化函数 ────────────────────────────────────────────────
-- 等价于 JS 侧 sync-engine/src/lib/hash.ts 的 canonicalize → JSON.stringify：
--   - 对象 key 按字典序（纯 alphabetical）排列
--   - 紧凑格式：key:value 之间无空格，元素之间无空格
--   - 数组保持原始顺序
--   - 原始值使用 JSONB 原生 ::text（数字/布尔/null 格式与 JS JSON.stringify 一致）
--
-- PG 原生 jsonb::text 不适用的原因：
--   1. 冒号后有空格 {"key": "val"} vs JS 的 {"key":"val"}
--   2. key 排序规则是先按长度再按字典序，与 JS 的纯字典序不同

CREATE OR REPLACE FUNCTION st_platform.canonical_jsonb(val JSONB)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  t       TEXT;
  parts   TEXT[] := '{}';
  k       TEXT;
  v       JSONB;
  elem    JSONB;
BEGIN
  IF val IS NULL THEN
    RETURN 'null';
  END IF;

  t := jsonb_typeof(val);

  IF t = 'object' THEN
    FOR k, v IN
      SELECT kv.key, kv.value
        FROM jsonb_each(val) AS kv
       ORDER BY kv.key  -- 纯字典序，匹配 JS Object.keys().sort()
    LOOP
      parts := array_append(
        parts,
        to_jsonb(k)::text || ':' || st_platform.canonical_jsonb(v)
      );
    END LOOP;
    RETURN '{' || array_to_string(parts, ',') || '}';
  END IF;

  IF t = 'array' THEN
    FOR elem IN
      SELECT ae.value FROM jsonb_array_elements(val) AS ae
    LOOP
      parts := array_append(parts, st_platform.canonical_jsonb(elem));
    END LOOP;
    RETURN '[' || array_to_string(parts, ',') || ']';
  END IF;

  -- string / number / boolean / null：JSONB ::text 的格式与 JSON.stringify 一致
  -- string → '"hello"'（含引号和 JSON 转义）
  -- number → '42' 或 '3.14'
  -- boolean → 'true' / 'false'
  -- null → 'null'
  RETURN val::text;
END;
$$;

COMMENT ON FUNCTION st_platform.canonical_jsonb(JSONB) IS
  '将 JSONB 值序列化为与 JS JSON.stringify(canonicalize(obj)) 一致的紧凑 JSON 字符串。'
  'key 按纯字典序排列，无多余空格。用于计算跨语言一致的 content_hash。';

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

  -- ⑤ 计算 content_hash —— 使用 canonical_jsonb() 确保与 JS 侧一致
  new_hash := encode(
    digest(
      st_platform.canonical_jsonb(
        jsonb_build_object(
          'platform_version', new_version,
          'settings_jsonb',   new_jsonb,
          'writable_paths',   prev.writable_paths
        )
      ),
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
