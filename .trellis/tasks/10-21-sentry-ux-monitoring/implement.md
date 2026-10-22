# 执行计划

按 `task.md` 的顺序，一个任务一个提交（Conventional Commit，如 `feat(monitoring): ...`），不自动 push。

## 前置

- 负责人审核 `prd.md`、`design.md`，确认 PRD 待决问题 1、2。
- `python ./.trellis/scripts/task.py start 10-21-sentry-ux-monitoring`，之后才写产品代码。
- 开始前读：`.trellis/spec/frontend/app/index.md`、`.trellis/spec/backend/app/index.md`、`.trellis/spec/shared/contracts/index.md`、`.trellis/spec/guides/cross-layer-thinking-guide.md`。

## 每个任务的通用验证

- 后端：`pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`
- 前端：`pnpm --filter @miniapp/frontend typecheck && test && lint && build`
- 动 shared：`pnpm --filter @miniapp/shared test` 与所有消费者 typecheck
- `pnpm lint:imports`、`pnpm lint:legacy`

## 失败路径与人工场景（必须覆盖）

- 埋点抛异常时业务请求照常完成。
- 慢请求（浏览器开发者工具节流或后端临时延迟，仅 development）：出现 `slow_request`，带 requestId，能点到 Replay 与后端 trace。
- 请求超时：用户看到现有错误态，事件 outcome 为 `timeout`。
- 页面 4 秒未就绪：出现 `page_stall` 且列出在途请求；页面切到后台期间不误报。
- 按钮 2.5 秒无反馈：出现 `action_stall`。
- 弱网/Telegram WebView（Android 与 iOS 各一台真机）：首屏指标无明显退化。
- 抽样检查事件与 metrics attributes 中无 initData、token、聊天正文、完整 URL query。

## 提交前检查

- 新增注释只解释"为什么"；阈值常量集中定义并注明"初值，待基线校准"。
- 不新增 `any`；契约若有变化先改 `packages/shared`。
- 是否新增测试文件：T1 与 `apiClient` 超时属于高风险改动，需负责人确认后再建；未确认则只做既有测试 + 人工验证并记录剩余风险。
