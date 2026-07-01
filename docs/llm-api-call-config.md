# LLM 调用配置说明（URL / Key / Model 与配置位置）

> 说明一次对话请求实际使用的 **URL、Key、Model**，以及它们分别配置在哪里。
> 环境以 Railway `gallant-insight` / `development` + 对应前端为准。

## 请求链路（两跳）

```
ST(iframe) ──①──▶ ST server(/api/backends/chat-completions/generate)
           ──②──▶ 平台代理 backend(llm-proxy)
           ──③──▶ 上游 OpenRouter
```

- ①→② 使用 ST 的 **custom 源**配置（custom_url + api_key_custom）。
- ②→③ 由 backend 校验用户身份后，注入**真实 key** 转发到上游。

---

## 第 1 跳：ST → 平台代理（llm-proxy）

| 项        | 实际值                                                             | 配置位置                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **URL**   | `http://stminiapp.railway.internal:8080/api/platform/llm-proxy/v1` | ST `data/<handle>/settings.json` 的 `oai_settings.custom_url`（及 `reverse_proxy`）。由 **sync-engine `packages/sync-engine/src/provisioner/merger.ts`** 强制写入；值来自 **st-bundle 环境变量 `LLM_PROXY_URL`**                                                                      |
| **Key**   | `api_key_custom` = **每用户 platformToken（JWT，非真实 key）**     | ST `data/<handle>/secrets.json`。由 **sync-engine `packages/sync-engine/src/provisioner/writer.ts` 的 `signPlatformToken()`** 签发；签名密钥 = `LLM_PROXY_TOKEN_SECRET` ‖ 回退 `ST_USER_PASSWORD_SECRET`（st-bundle 用回退值）。key 槽名 = `api_key_${provider}`，provider = `custom` |
| **Model** | `google/gemini-2.5-flash`（标准档）                                | ST `settings.json` 的 `oai_settings.custom_model`。`merger.ts` 在缺省时兜底为标准档模型；用户切档经 st-extension `handlers/change-model.ts` 改写（标准 = `google/gemini-2.5-flash`，高级 = `anthropic/claude-sonnet-4`）                                                              |

## 第 2 跳：平台代理 → 上游 OpenRouter

| 项        | 实际值                                                     | 配置位置                                                                                                                                                      |
| --------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **URL**   | `https://openrouter.ai/api/v1`（默认）                     | **backend（stminiapp）环境变量 `LLM_UPSTREAM_URL`**；当前未设，走 `packages/backend/src/routes/llm-proxy.ts` 的硬编码默认值                                   |
| **Key**   | **真实 key** = `LLM_API_KEY` ‖ 回退 `OPENAI_API_KEY`       | **backend 环境变量**；当前 `LLM_API_KEY` 未设，实际用回退的 `OPENAI_API_KEY`。代理以 `Authorization: Bearer <key>` 注入（`llm-proxy.ts` 的 `forwardHeaders`） |
| **Model** | 透传第 1 跳的 `body.model`（即 `google/gemini-2.5-flash`） | 无需单独配置；同时用它查 `packages/backend/src/platform/model-tiers.ts` 得扣费额度（标准 10 / 高级 15）                                                       |

---

## 密钥与校验（易混点）

- **验签**：backend `packages/backend/src/lib/llm-token.ts` 的 `verifyPlatformToken()` 用 `LLM_PROXY_TOKEN_SECRET` ‖ `ST_USER_PASSWORD_SECRET` 验 platformToken，取出 `userId` → 决定扣谁的费。
- **两服务必须一致**：`ST_USER_PASSWORD_SECRET`（backend 与 st-bundle 相同）用于 platformToken 的签名/验签。
- **两个"密钥"别混**：
  - `ST_USER_PASSWORD_SECRET`（两端一致）→ 只用来标识"这是哪个用户"，不是给上游付费的 key。
  - `OPENAI_API_KEY` / `LLM_API_KEY`（仅 backend）→ 真正给 OpenRouter 付费的 key，ST 侧永远拿不到。

## 计费

- `llm-proxy.ts`：解析 `body.model` → `getModelTier()` 得 `deductionRate`（标准 10 / 高级 15）。
- 发起上游前做 **余额预检**（不足 → 402，不调用上游）。
- SSE 流正常结束（收到 `data: [DONE]`）后才扣费；上游 5xx / 流中断不扣。
- 钱包表：`miniapp.user_wallets`（`total_credits` 为生成列 = `main_credits + bonus_credits`）；扣费 RPC `deduct_wallet_credits` 先扣 `bonus_credits` 再扣 `main_credits`。

## 环境变量归属速查

| 变量                                                       | 服务                | 作用                                                         |
| ---------------------------------------------------------- | ------------------- | ------------------------------------------------------------ |
| `LLM_PROXY_URL`                                            | st-bundle           | provision 写入 ST 的 custom_url/reverse_proxy（第 1 跳 URL） |
| `LLM_PROXY_TOKEN_SECRET`（回退 `ST_USER_PASSWORD_SECRET`） | st-bundle + backend | platformToken 签名/验签，两端必须一致                        |
| `ST_USER_PASSWORD_SECRET`                                  | st-bundle + backend | 上者的回退密钥；两端一致                                     |
| `LLM_UPSTREAM_URL`                                         | backend             | 上游地址（未设→openrouter.ai）                               |
| `LLM_API_KEY`（回退 `OPENAI_API_KEY`）                     | backend             | 上游真实付费 key                                             |

> 备注：当前 `LLM_UPSTREAM_URL`、`LLM_API_KEY` 均靠**回退值**运行（默认 openrouter + `OPENAI_API_KEY`）。功能正常，但建议显式设置这两个变量，避免 `OPENAI_API_KEY` 日后被改作他用时静默串味。
