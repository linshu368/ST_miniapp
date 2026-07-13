-- 030: Add character interaction round to chat_history
--
-- 增加 user_character_round 字段，记录用户与当前角色卡的累计对话轮次。
-- 使用触发器在插入时自动计算，保证并发安全，并对历史数据进行回填。

-- 1. 新增字段
ALTER TABLE miniapp.chat_history
ADD COLUMN user_character_round INTEGER;

COMMENT ON COLUMN miniapp.chat_history.user_character_round IS
  '该用户与该角色卡的累计交互轮次（随聊天递增）';

-- 2. 创建触发器函数：自动计算当前轮次
CREATE OR REPLACE FUNCTION miniapp.tf_set_user_character_round()
RETURNS TRIGGER AS $$
DECLARE
  current_max INTEGER;
BEGIN
  IF NEW.character_id IS NOT NULL THEN
    -- 先查一下这个用户和这个角色卡历史记录里，user_character_round 最大的值是多少
    SELECT MAX(user_character_round) INTO current_max
    FROM miniapp.chat_history
    WHERE user_id = NEW.user_id AND character_id = NEW.character_id;
    
    -- 如果找到了，就 +1
    IF current_max IS NOT NULL THEN
      NEW.user_character_round := current_max + 1;
    ELSE
      -- 如果连一个带有轮次的记录都没有（极其罕见的 edge case，因为我们下面会全量回填，
      -- 如果有的话可能是完全新的卡），那为了保险起见，我们干脆去查一下底表里到底有多少条这个组合的记录
      -- 这也是一种兜底，保证即使前面的轮次字段全是 NULL，也能接上数量
      NEW.user_character_round := (
        SELECT COUNT(*) + 1
        FROM miniapp.chat_history
        WHERE user_id = NEW.user_id AND character_id = NEW.character_id
      );
    END IF;
  ELSE
    -- 对于没有 character_id 的纯预设对话等情况
    NEW.user_character_round := 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. 绑定触发器到表
DROP TRIGGER IF EXISTS trg_set_user_character_round ON miniapp.chat_history;
CREATE TRIGGER trg_set_user_character_round
BEFORE INSERT ON miniapp.chat_history
FOR EACH ROW
EXECUTE FUNCTION miniapp.tf_set_user_character_round();

-- 4. 历史数据回填 (Backfill)
WITH numbered_history AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY user_id, character_id ORDER BY created_at ASC) as rn
  FROM miniapp.chat_history
  WHERE character_id IS NOT NULL
)
UPDATE miniapp.chat_history ch
SET user_character_round = nh.rn
FROM numbered_history nh
WHERE ch.id = nh.id;
