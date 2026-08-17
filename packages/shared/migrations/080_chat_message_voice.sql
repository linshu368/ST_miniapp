-- 080_chat_message_voice.sql
--
-- 聊天页角色语音：每条角色回复可生成一段语音，落库并存进对象存储。
--
-- 为什么要落库而不是只放前端内存：产品要求「已生成的语音保持不变」，
-- 退出会话重进、换设备都应当还能播。只存内存的话刷新即失效，
-- 用户会以为语音丢了，然后重复生成——那是真金白银的上游调用。
--
-- 为什么单开一张表而不是往 chat_history 加列：
-- 语音是可选的旁支产物，绝大多数消息不会有；加列会让主表每行都背上七八个
-- 长期为 NULL 的字段，而 chat_history 是流式写入路径上最热的表。
--
-- message_id 指向 chat_history.id，也就是 toChatMessages 给 assistant 消息用的那个 id。
-- 用户消息的 id 是 "<history_id>:user"、开场白是 "opening:<session_id>"，都不是库里的行，
-- 天然进不来——与产品口径「只有角色回复能生成语音」一致，不需要额外的类型校验。
-- 重生成会写入新的 revision 行、拿到新 id，因此旧语音不会错挂到新回复上。
--
-- 计费口径（本期）：不扣星尘，但每次生成都留一行，用量后续按行统计。
-- 因此本表是追加写的，重新生成不覆盖旧行，只把旧行的 is_active 置否——
-- 与 chat_messages 的 revision/is_active 是同一套语义，读路径口径一致。

BEGIN;

CREATE TABLE IF NOT EXISTS miniapp.chat_message_audio (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  message_id    UUID NOT NULL REFERENCES miniapp.chat_history(id) ON DELETE CASCADE,
  -- 冗余 session_id：会话页要一次取回整段对话的语音。没有它就得 join chat_history，
  -- 而读路径走 PostgREST，跨表过滤只能靠嵌套 select，写起来和走索引都更差。
  session_id    UUID NOT NULL REFERENCES miniapp.chat_sessions(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES miniapp.users(id) ON DELETE CASCADE,

  revision      INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  is_active     BOOLEAN NOT NULL DEFAULT true,

  -- pending 是「已受理、上游还在跑」。生成要几十秒，接口不能同步等，
  -- 先落 pending 行再异步补齐，前端据此显示「生成中」，刷新页面也不会丢状态。
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'ready', 'failed')),

  voice_id      TEXT NOT NULL,
  tts_model     TEXT NOT NULL,
  -- 合成语速。播放倍速是前端 playbackRate，不落这里——它对已有语音即时生效，
  -- 不该把历史语音标记成「用另一个速度生成的」。
  tts_speed     NUMERIC(3, 2) NOT NULL,

  -- 用量与效果排查：原文多少字、实际念出来多少字、耗时多久
  source_chars  INTEGER NOT NULL DEFAULT 0,
  spoken_chars  INTEGER NOT NULL DEFAULT 0,
  -- LLM 改写后真正送进 TTS 的文本。念错了要能对着它复盘，不然只能靠听
  spoken_text   TEXT,

  storage_path  TEXT,
  audio_url     TEXT,
  duration_ms   INTEGER,
  latency_ms    INTEGER,
  error_code    TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 一条消息同时只能有一个生效版本。重复点击生成靠它拦截，不靠应用层判重：
-- 用户连点两下时两个请求会并发到达，读-改-写在这里必然漏。
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_message_audio_active
  ON miniapp.chat_message_audio (message_id)
  WHERE is_active;

-- 进入会话时一次取回该会话全部生效语音
CREATE INDEX IF NOT EXISTS idx_chat_message_audio_session
  ON miniapp.chat_message_audio (session_id)
  WHERE is_active;

-- 用量统计：按用户看某段时间生成了多少条
CREATE INDEX IF NOT EXISTS idx_chat_message_audio_user_created
  ON miniapp.chat_message_audio (user_id, created_at DESC);

COMMENT ON TABLE miniapp.chat_message_audio IS
  '角色回复的语音产物。追加写：重新生成插新行并把旧行 is_active 置否，'
  '既保留「当前语音」也保留完整用量流水（本期不扣费，仅计量）。';
COMMENT ON COLUMN miniapp.chat_message_audio.status IS
  'pending = 已受理、上游未回；ready = 可播放；failed = 失败可重试。'
  '进程重启会留下永远 pending 的行，读路径按 created_at 超时判定为 failed。';
COMMENT ON COLUMN miniapp.chat_message_audio.spoken_text IS
  'LLM 按语音模板改写、清洗去标签后真正送进 TTS 的文本，与消息正文不同。';

ALTER TABLE miniapp.chat_message_audio ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.chat_message_audio FROM PUBLIC, anon, authenticated;
GRANT ALL ON miniapp.chat_message_audio TO service_role, postgres;

-- ─── 用户级语音偏好 ─────────────────────────────────────────────────────────
-- 与 pref_word_count 等同域：对该用户的所有角色生效，不做会话级覆盖。
ALTER TABLE miniapp.miniapp_user_settings
  ADD COLUMN IF NOT EXISTS pref_voice_id TEXT;

ALTER TABLE miniapp.miniapp_user_settings
  ADD COLUMN IF NOT EXISTS pref_voice_playback_rate NUMERIC(3, 2) NOT NULL DEFAULT 1.0
    CHECK (pref_voice_playback_rate BETWEEN 0.5 AND 2.0);

COMMENT ON COLUMN miniapp.miniapp_user_settings.pref_voice_id IS
  '默认音色 id（MiniMax voice_id）。NULL = 用后端音色目录里的默认项。'
  '改音色只影响之后新生成的语音，已生成的保持不变。';
COMMENT ON COLUMN miniapp.miniapp_user_settings.pref_voice_playback_rate IS
  '播放倍速，前端 HTMLAudioElement.playbackRate。对已生成的语音即时生效，不触发重新合成。';

-- ─── 音频对象存储 ───────────────────────────────────────────────────────────
-- 公开桶：音频地址直接进 <audio src>，签名 URL 会过期，而语音要长期可播。
-- 路径含用户 id 与消息 id，不可枚举，且桶内只有语音这一种资产。
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'miniapp-chat-voice',
  'miniapp-chat-voice',
  true,
  10485760,
  ARRAY['audio/mpeg']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

COMMIT;

NOTIFY pgrst, 'reload schema';
