-- 026: 平台 LLM 交互日志
--
-- 记录每轮经过 llm-proxy 的完整请求与响应，用于运营监控和内容审计。
-- 每次 LLM 调用落一行（一轮对话 = 一行）。
--
-- 写入时机：llm-proxy SSE 流正常结束后 fire-and-forget insert。
-- Schema 归属：miniapp（平台监控数据，非 ST 运行时镜像）。

CREATE TABLE IF NOT EXISTS miniapp.chat_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- 实际使用的模型（来自 request body.model）
  model           TEXT NOT NULL,

  -- 本轮用户输入（messages 数组中最后一条 role=user 的 content）
  user_input      TEXT NOT NULL,

  -- 模型返回的 assistant 回复完整文本
  assistant_reply TEXT,

  -- 完整的 messages 上下文（含 system prompt + 历史轮次），JSONB 数组
  history         JSONB NOT NULL,

  -- 关联上下文（MVP 先 nullable，后续 st-extension 注入 header 后填充）
  character_id    UUID REFERENCES miniapp.characters(id) ON DELETE SET NULL,
  preset_id       UUID,

  -- 请求结果状态：success / upstream_error / stream_interrupted
  status          TEXT NOT NULL DEFAULT 'success',
  upstream_status INTEGER,

  -- 本次扣费额
  deduction_rate  NUMERIC(10,2) DEFAULT 0,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 按用户 + 时间倒序查询
CREATE INDEX idx_chat_history_user
  ON miniapp.chat_history(user_id, created_at DESC);

-- 按模型统计
CREATE INDEX idx_chat_history_model
  ON miniapp.chat_history(model, created_at DESC);

-- 授权 service_role 和 postgres 访问（miniapp schema 无 DEFAULT PRIVILEGES）
GRANT ALL ON miniapp.chat_history TO service_role, postgres;

COMMENT ON TABLE miniapp.chat_history IS
  '平台 LLM 交互日志。每次 llm-proxy 调用落一行，记录用户输入、完整上下文(history)和模型回复，'
  '用于运营监控、内容审计和用量分析。';
