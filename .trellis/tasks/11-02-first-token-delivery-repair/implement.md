# 执行计划

1. 迁移：新增 `packages/shared/migrations/20261102_first_token_server_delivery_billing.sql`（替换闸门与回报函数，保留 owner/ACL），新增 `tests/first_token_server_delivery_billing.sql` 并接入 `scripts/test-first-token-fallback-local.sh`。
2. Shared：`ConversationStreamStartEvent.server_elapsed_ms?`。
3. Backend：`generate.ts` emitStart 写入耗时；`first-token-fallback.ts` 放开同型号；`execute.ts` 供应商顺序；`app.ts` maxAge=7200。
4. Frontend 提示：`conversation-stream.ts` 新文案与 URL 回传；`page.tsx` 软样式；`use-conversation-turn.ts` 超时回调与收尾清理。
5. Frontend 保温：`lib/api/connection-warmth.ts`、`hooks/use-api-connection-warmth.ts`，聊天页接入。
6. Frontend 归因：`first-token-observation.ts` 扩展，`perf/grafana.ts` 白名单。
7. 看板与文档：`docs/grafana/st-engineering-roleplay.json`、`docs/grafana/engineering-performance.md`、`docs/first-token-fallback.md`、相关 spec。
8. 验证：单测、类型、lint、build、本地 PG、`@chat` 验收。
9. 向用户提交文件清单与差异，获批后再提交、推送、合 dev、TEST、生产。

## 失败路径覆盖

服务端超时、晚于预算出字、客户端超时但按时交付、免费轮次、无回报、主动停止、离页、双路同时失败、同型号第二路获胜、RT 缺失、无 start、保温失败、隐藏页、空闲超时。

## 手工场景

Telegram 真机：停留 3 分钟后发送、弱网、切后台返回；TEST 环境核对扣费账本。
