# 10月30日性能回归分析与优化

## Goal

根据 2026-10-30 15:00 前日报与当前分支实现，降低 `/characters`、`/profile`、`/dramas/:id`、`/`、`/create/studio/:conversationId` 和聊天发送/重生成链路中可由本仓库控制的等待与首屏资源竞争，同时保持业务、计费、SSE 与恢复语义不变。

## Requirements

- 以日报的页面/API P95、样本量、错误分布和 Grafana 首字/完整回复分段为依据；不得把低样本、完整流时长或监控口径变化宣称为真实性能收益。
- 复用 10-29 已完成的目录缓存、图片变体、关键视觉指标和 10-30 已完成的聊天派发准备优化，不重复建设缓存、SSE client 或观测链路。
- `/characters` 减少首屏头像之间的高优先级带宽竞争；列表、收藏、社交和返回恢复行为不变。
- `/profile` 让决定页面可用的余额请求优先于非关键请求排队；签到、VIP、社区、邀请和未读功能不变。
- 影像广场在用户进入工作室前安全预热已有配置 query；配置仍以 React Query/服务端为真相，不持久化价格或模型配置。
- `/` 与 `/dramas/:id` 仅延迟加载首次打开才需要的选集面板代码；播放、续播、返回、手势和首帧请求不延迟。
- 聊天路由并行独立的模型目录读取与幂等用户身份映射，并把 SSE `done` 后的建议性富回复诊断移出响应等待；开轮、身份持久化、终态 CAS、计费和额度释放仍为同步门禁。
- `/api/support/unread` 当前 P95 良好，本轮不做无证据改动。
- 不新增公开 API、shared DTO、依赖、数据库对象或 migration；不记录敏感信息。

## Acceptance Criteria

- [ ] 角色首屏仅给实际首行头像高优先级，首屏外图片仍按需加载且关键视觉终态可收敛。
- [ ] Profile 余额 GET 使用现有 critical 请求槽；其它功能和错误态无回归。
- [ ] Create feed 首包结算后预热同一份 image-plaza config query；工作室仍能在配置/会话失败时显示既有失败状态。
- [ ] 选集 Sheet 从 `/`、`/dramas/:id` 初始 chunk 移出，首次点击后仍能打开并完成选集/简介操作。
- [ ] 会话路由的模型目录与用户身份映射并行；配置截止、鉴权和 session ownership 仍生效。
- [ ] 客户端收到 `done`/流关闭后，富回复诊断失败或变慢不再延长 handler 返回；失败仍记录安全告警，下一轮按既有保守规则运行。
- [ ] Frontend/Backend typecheck、相关既有 tests、lint、frontend build 和 `git diff --check` 通过；无法完成的真实生产验证单独记录。
- [ ] 记录上线后验证口径：同 release 至少 24 小时并带样本量比较页面 P95、首字、完整回复及失败率；本地结果不冒充生产收益。

## Constraints

- Node.js `>=22`、pnpm、严格 TypeScript；页面服务端数据仅通过 `src/lib/api` React Query hooks。
- 不改变 UX 文案与布局，不新增自动重试或跨用户缓存。
- 生产效果必须发布后按相同 release/cohort 验证；日报中 `/api/v1/conversations/*` 的完整流 P95 不等同于首字等待。
