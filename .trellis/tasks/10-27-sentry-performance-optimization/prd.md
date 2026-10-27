# 优化 Sentry 高延迟页面与公共 API 链路

## Goal

在不改变前端交互、公开 API、计费规则与对话生成时限的前提下，减少页面并发请求对 Supabase `users` 与 `runtime_config` 的重复访问，优先改善 `/profile`、`/profile/spending`、`/chat/:characterId` 及其共用鉴权接口的长尾和 5xx 放大。

## Requirements

- 复用现有 `getOrCreateDbUser`、`runtime-config.ts` 和 payment domain，不新增第二套数据库 client、缓存服务或聚合 API。
- 同一 Backend 进程内，同一 Telegram 用户的并发身份解析只能有一个回源请求；只缓存不可变的内部用户身份字段，不能缓存钱包、权益、额度、`source_id` 或累计轮次。
- 身份缓存必须有 TTL 与容量上限；失败不得缓存，首次创建仍依赖 `tg_id` 唯一约束处理并发，不以进程锁代替数据库一致性。
- `runtime_config` 的并发去重只合并正在执行的相同读取，不增加跨请求陈旧窗口；严格读取和带调用方 `AbortSignal` 的读取保持独立。
- `/api/payment/plans` 当前并行读取的页面配置应复用统一批量入口，将同表多次往返合并；套餐缺失或非法仍 fail closed，非关键文案仍按现有默认值降级。
- 不更改 Supabase 全局重试配置。GET/HEAD 的 SDK 自动重试仍由现有版本负责，应用层 timeout 保持总等待上界。
- 不调整 `POST .../messages` / `regenerate` 的 LLM、SSE、计费或可恢复交付预算；这些接口的整体 p95 不能用提前失败伪装成提速。
- 不新增 migration、环境变量、依赖或 shared/Frontend 契约。
- 日志不得新增 Telegram initData、token、支付信息、聊天正文或其他敏感内容。

## Evidence and Scope

- Sentry 报告窗口 `2026-10-26 15:00` 至 `2026-10-27 15:00`：`/chat/:characterId` navigation p95 24.84s、`/profile/spending` 8.55s、`/profile` 7.18s；生产 `http.server` 5xx 中会话模块约 58%，Supabase `http.client internal_error` 约 1,570 条，其中 `users` 820、`runtime_config` 220。
- 2026-10-27 15:00 后补采的已接收样本已恢复健康时延：`users` 340 次、p95 69.7ms；`runtime_config` 535 次、p95 123.9ms，状态均为 ok。它说明本批次应优先降低重复请求放大，而不是继续压低 timeout。
- Sentry spans/logs 存在大量丢弃，绝对 count 只能用于同口径对照，不能当完整业务请求量。

## Non-goals

- 不新建 Profile bootstrap 聚合接口，不改页面布局、加载文案或查询 freshness。
- 不调整角色排名缓存；当前 `ranking-stats.ts` 已有 TTL + single-flight。
- 不做数据库索引、连接池、生产配置或 Supabase 数据操作。
- 不以 test 环境结论替代 production 实况，也不在本任务自动发布或修改 Sentry issue 状态。

## Acceptance Criteria

- [x] 同一用户的并发 `getOrCreateDbUser` 调用只执行一次完整用户解析；成功后短 TTL 命中只暴露 `id` 与 `created_at`。
- [x] 不同用户不会串用缓存；失败 Promise 清理后下一次可以重新回源；缓存达到上限时有界淘汰。
- [x] 需要 `source_id` / `total_round` 的现有调用方改走完整用户读取并通过 TypeScript 校验，避免误用身份缓存。
- [x] 相同 key 或相同 key 集合的无自定义 signal 非严格 runtime-config 并发读取只发起一次 PostgREST 请求；失败后不留拒绝态。
- [x] 严格读取、不同 key 集合和带调用方 signal 的读取不被错误合并。
- [x] `GET /api/payment/plans` 的页面配置由一次批量 runtime-config 读取解析，响应形状与 fail-closed/default 行为不变。
- [x] 新增并发/缓存回归测试，并运行 Backend typecheck、完整 Backend 现有测试、相关 lint/静态检查以及 `git diff --check`。
- [ ] 人工注入验证 `/profile`、`/profile/spending`、角色进入聊天、支付套餐正常/缺失/损坏三类场景；不要求修改现有 UI fixture。
- [ ] 发布后按同环境、同 release/窗口复查页面 navigation p95、目标接口 p95/5xx、`users`/`runtime_config` 每请求比率与 dropped outcomes；失败率上升或配置传播语义异常时回滚应用版本。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design, `implement.md` for execution planning, and `task.md` for the executable task breakdown before `task.py start`.
