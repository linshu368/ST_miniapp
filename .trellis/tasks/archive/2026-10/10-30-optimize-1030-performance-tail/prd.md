# 30日性能长尾分析优化

## Goal

在 10 月 30 日首轮性能优化和部署链路调查的基础上，进一步降低 Telegram Android WebView 冷启动及主导航时的非目标 JavaScript/RSC 下载与解析竞争，保持页面、缓存、导航、调试和业务功能不变。

## Requirements

- 复用已完成的角色图片优先级、Profile wallet critical、工作室配置预热、短剧 EpisodeSheet 拆包、聊天准备并行和流结束尾处理，不重复修改这些路径。
- 核对 production 构建中 React Query Devtools 的实际产物；没有可量化收益时保持现状，不为拆包数字增加 loader。
- BottomNav 不得因链接进入视口而自动预取非目标 tab；保留 mouse/focus/touch 明确意图时的预取，以及慢网/省流量下对重路由的保护。
- Profile 社群 Sheet 在用户首次打开前不得进入初始页面 chunk；首次打开、关闭动画、重新打开、验证与领奖缓存行为保持。
- 不改变 API、shared DTO、React Query query key、导航地址、业务文案、数据库、运行配置或依赖版本。
- messages/regenerate 的 50–110 秒完整生成长尾没有安全的前端代码捷径；本任务不得通过缩短回复、改变模型、提前截断流或放松计费/恢复语义伪造改善。

## Acceptance Criteria

- [x] 已确认 React Query Devtools 的 production export 本就是 `null`；动态导入只产生 260B 空壳且无实际减载，故撤回该候选改动。
- [x] BottomNav 所有 tab 使用 `prefetch={false}` 禁止视口自动预取；非当前 tab 的显式 hover/focus/touch 仍调用既有 `router.prefetch`，重路由仍受网络条件约束。
- [x] Profile 社群 Sheet 动态加载且首次打开后保持挂载；未打开时不加载对应动态 chunk。
- [x] `/characters`、`/profile`、`/`、`/dramas`、`/create` 的导航、高亮、未读红点和角色滚动恢复行为无回归。
- [x] Frontend typecheck、现有 tests、lint、production build、相关 UI 场景和 `git diff --check` 通过；构建前后首屏 chunk 变化写入验证记录。
- [x] 记录发布后按 `release + Telegram Android` 观察至少 24 小时的页面 P50/P95、样本量与错误率；本地 chunk 下降不冒充生产 P95 收益。

## Constraints

- Node.js `>=22`、pnpm、React 18、Next.js App Router、TypeScript strict。
- 页面服务端状态继续只通过 `src/lib/api` React Query hooks；不增加请求、重试、缓存层或全局状态源。
- 不修改生产配置或触发部署；生产效果必须在合并发布后验证。
