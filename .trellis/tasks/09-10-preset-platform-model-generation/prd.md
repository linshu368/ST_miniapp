# Preset Platform 模型目录与内部生成

## Goal

参考 Admin OpenRouter 目录交互实现模型查询/选择，并接入 generation 内部测试 purpose 与 SSE 生成。

## Requirements

- 提供 Preset Platform 专用模型目录端点，参考 Admin `openRouterModels.ts` / `ModelCatalogEditor.tsx` 的处理方式。
- 按环境 API base 拉取 backend 目录，使用 shared `OpenRouterModelDirectorySchema` 校验，支持按 name/id/description/canonical slug 搜索，展示 stale/同步状态、上游时间、总数、过期/不可用状态和强制刷新。
- 正常可调用的 OpenRouter 模型均可选择；首期不做高价模型 allowlist，但需要 operator 限频、并发和整体 deadline。
- 在 backend `features/generation` 内新增 internal test purpose，复用 OpenRouter timeout/SSE/prompt cache/provider request id，不触发 MiniApp 钱包、免费额度或正式 `chat_history`。
- 实现单段 preset composer：preset system instruction + character system prompt + 成功历史 + 当前输入。
- 支持原子开轮、busy、idempotency、SSE `start/delta/done/error`、断线 drain、retry/恢复。

## Acceptance Criteria

- [ ] 模型目录 fresh/stale/no-cache/force refresh 场景可测，429/5xx/timeout 有稳定错误。
- [ ] 会话生成不会写 MiniApp `experience.chat_sessions/chat_history`，不会扣钱包或消耗免费额度。
- [ ] 上游流前失败返回 HTTP JSON，流内失败返回 SSE error；不会生成伪助手消息。
- [ ] 重复请求、同会话并发、断线和重启后陈旧 streaming 均有测试。
- [ ] fake upstream E2E 覆盖 request id、finish reason、model/release 快照和终态落库。
- [ ] 根据实现补充 backend generation/model 相关 spec，并回填 shared 契约差异。

## Notes

- 依赖 backend foundation 和数据库会话/RPC。
- 不能新增第二套 OpenRouter key、浏览器直连或绕过 generation 的上游调用。
