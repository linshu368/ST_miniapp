# 测试卡模拟对话

## 前置配置

1. 执行 `packages/shared/migrations/054_simulation_card_evaluation.sql`。
2. 在 Supabase API 的 exposed schemas 中加入 `miniapp_simulation`；本地
   `supabase/config.toml` 已配置。
3. backend 配置 `SIMULATION_SERVICE_KEY`。
4. backend 与 st-bundle 保持相同的 `LLM_PROXY_TOKEN_SECRET`。
5. st-bundle 镜像内需有 Chromium；仓库 Dockerfile 已安装 Debian `chromium`。

## 导入测试卡

```bash
pnpm import-character ./cards -- --test --json --env packages/sync-engine/.env
```

也可以一次传入多个文件或目录。stdout 是 JSON 清单；诊断日志写入 stderr。
相同原始文件字节的 SHA-256 已存在时，不会重复插入或上传。

## 单轮接口

```http
POST /api/platform/simulation/chat
Authorization: Bearer <SIMULATION_SERVICE_KEY>
Content-Type: application/json
```

首次请求：

```json
{
  "card_hash": "<64位sha256>",
  "user_message": "你好",
  "metadata": {
    "persona": "persona-a",
    "batch_id": "batch-20260722"
  }
}
```

续聊时传回服务端返回的 `conversation_id`。若要对同一卡新开另一个会话，
不要传旧 `conversation_id`。

```json
{
  "card_hash": "<64位sha256>",
  "conversation_id": "<uuid>",
  "user_message": "继续刚才的话题",
  "model_id": "<可选的生产模型稳定ID>",
  "metadata": {
    "round": 2
  }
}
```

`card_hash` 和 `name` 必须二选一。name 同名时返回 HTTP 409，并在
`error.candidates` 中列出候选 `character_id/card_hash`。

成功响应包含角色原始回复、`chat_log_id` 和最终生效的模型、预设版本及采样参数。
模拟请求只写 `miniapp_simulation.chat_log`，不会创建 `miniapp.users`、写入
`miniapp.chat_history` 或调用钱包扣费。
