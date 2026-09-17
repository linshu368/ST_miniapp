# 图片生成 PostHog 接入规划

## Goal

为图片生成功能规划 PostHog 接入方案，复用当前项目在聊天 replay 与支付模块中的 telemetry 接入模式，明确事件定义、Frontend/Backend 接入节点、配置要求、可靠性边界和验证方式。

## Requirements

- 规划必须覆盖 `packages/frontend` 聊天图片 UI、`packages/backend` 图片描述/出图 route 与 worker 终态、`packages/shared` telemetry 契约。
- 事件必须先经 shared schema 定义，再被前后端消费；不得在组件、route 或 worker 中私定义 PostHog payload。
- 必须参考现有支付模块方式：前端走 `getReplayLifecycle().capture`；后端走 observer + `captureReplayTelemetryEvent`；PostHog 失败不影响主流程。
- 必须列清楚需要新增的事件名、触发时机、生产方、关键属性和禁止属性。
- 必须列清楚 Frontend 与 Backend 中需要接入的具体文件、函数节点和接入方式。
- 必须保证配置正确：
  - Frontend 只使用 `NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST`，静态读取，缺失或非法 host 时 no-op。
  - Backend 只使用 `POSTHOG_API_KEY` / `POSTHOG_HOST` / `POSTHOG_TIMEOUT_MS`，经 `platform/config.ts`，缺失或非法 host 时 no-op。
  - 不新增 secret 到前端，不把 PostHog 配置写入 runtime_config。
- 必须明确隐私边界：禁止 prompt 正文、消息正文、图片 URL、Storage path、provider prompt/request id、完整 initData、token/secret、支付 URL 和错误 body 进入事件属性。
- 必须处理图片生成的异步特性：前端用户操作、后端受理、worker provider/Storage/结算终态分别建模，不能把 provider 成功等同业务成功。
- 本规划不实施产品代码、不创建数据库 migration、不开启生产采集。

## Acceptance Criteria

- [ ] Trellis artifact 包含复用调研、PRD、设计方案、执行计划和任务分解。
- [ ] 方案列出 Frontend 与 Backend 图片生成事件清单，并标明生产方、触发点、字段和去重策略。
- [ ] 方案列出 `packages/frontend`、`packages/backend`、`packages/shared` 需要修改的文件/模块和接入方式。
- [ ] 方案说明 PostHog 配置校验、no-op 行为、失败降级、隐私禁止字段和测试验证。
- [ ] 方案覆盖支付模块既有模式的复用点，并说明不复用/不新增的组件。
- [ ] 方案包含后续实现的验证命令和人工验收场景。

## Notes

- 参考现有模块：支付终态 telemetry、前端 payment flow telemetry、PostHog replay lifecycle、图片生成 route/worker。
