-- 086_pref_word_count_unset.sql
-- 让「用户没选过回复长度」这个状态在库里可表示，从而让运营台的 default_tier_id 真正生效。
--
-- 问题：pref_word_count 自 015 建表起就是 NOT NULL DEFAULT '300-500'，而写入路径
-- （MiniappUserSettingsRepository.getOrCreate）从不显式设置这一列，于是每个用户行一落地
-- 就带着一个「显式的」'300-500'。读取侧（getGenerationConfig / 前端 activeWordCount）的口径是
-- 「存档 id 仍在启用档位里就用存档值，否则才回落到 default_tier_id」，而 '300-500' 一直是个
-- 合法启用档，所以运营台把 runtime_config.pref_word_count_tiers.default_tier_id 改成别的档位后
-- 没有任何用户会跟随——表现为「运营台设了默认档，MiniApp 上还是旧档高亮」。
--
-- 改法：NULL 表示「未选择，跟随平台默认档」。列去掉默认值与 NOT NULL，新行不再带值；
-- 读取侧已有的 `?? default_tier_id` 回落链无需改动即可处理 NULL。
--
-- 刻意不回填存量行：本次只让默认档对新用户生效。把现有 '300-500' 置 NULL 会让 4105 个
-- 存量用户的回复长度立刻跟随当前默认档（500-800），回复变长、每轮 token 与星尘消耗上升，
-- 且无法区分「主动选了标准档」和「从未选过」——这属于运营决策，需要时另开一次数据变更。
--
-- 可回滚：见文件末尾注释。回滚会把所有 NULL 行重新钉回 '300-500'。

BEGIN;

ALTER TABLE miniapp.miniapp_user_settings
  ALTER COLUMN pref_word_count DROP DEFAULT;

ALTER TABLE miniapp.miniapp_user_settings
  ALTER COLUMN pref_word_count DROP NOT NULL;

-- 原约束 CHECK (char_length(trim(pref_word_count)) > 0) 对 NULL 求值为 NULL、本就放行，
-- 这里重建成显式写法，避免后续读代码的人以为 NULL 是漏网的。
ALTER TABLE miniapp.miniapp_user_settings
  DROP CONSTRAINT IF EXISTS miniapp_user_settings_pref_word_count_nonempty_check;

ALTER TABLE miniapp.miniapp_user_settings
  ADD CONSTRAINT miniapp_user_settings_pref_word_count_nonempty_check
  CHECK (pref_word_count IS NULL OR char_length(trim(pref_word_count)) > 0);

COMMENT ON COLUMN miniapp.miniapp_user_settings.pref_word_count IS
  '回复长度档位 id；NULL 表示用户从未选择、跟随 miniapp.runtime_config.pref_word_count_tiers 的 default_tier_id。非 NULL 但已下线的 id 同样由应用层回落到 default_tier_id。';

COMMIT;

-- 回滚：
--   BEGIN;
--   UPDATE miniapp.miniapp_user_settings SET pref_word_count = '300-500'
--     WHERE pref_word_count IS NULL;
--   ALTER TABLE miniapp.miniapp_user_settings
--     DROP CONSTRAINT IF EXISTS miniapp_user_settings_pref_word_count_nonempty_check;
--   ALTER TABLE miniapp.miniapp_user_settings
--     ADD CONSTRAINT miniapp_user_settings_pref_word_count_nonempty_check
--     CHECK (char_length(trim(pref_word_count)) > 0);
--   ALTER TABLE miniapp.miniapp_user_settings
--     ALTER COLUMN pref_word_count SET NOT NULL;
--   ALTER TABLE miniapp.miniapp_user_settings
--     ALTER COLUMN pref_word_count SET DEFAULT '300-500';
--   COMMIT;
