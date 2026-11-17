# 执行计划

1. 扩展工程路由与 `page.navigation` 低基数 2 秒预算维度，更新既有测试断言。
2. 为 `/creation` 和 `/profile` 接入与“真实主内容可见”一致的 ready；保留其异步数据错误和重试。
3. 在 characters、favorites、payment API 模块导出只读 prefetch helper，BottomNav intent 按目标调用；用平台策略排定两条后台 route chunk 优先级。短剧只做 route chunk 预热，避免目录预取与增量列表挂载竞态。
4. 新增五路由 Grafana dashboard JSON 和观测说明，校验 JSON 与 LogQL 维度；尝试通过当前 Grafana 连接更新，若无写能力记录导入阻塞。
5. 运行 `pnpm --filter @miniapp/frontend typecheck`、`test`、`lint`、`build`，并复用 `packages/ui-tests` 的五入口导航、profile/recharge 与剧场场景。
6. 更新受影响模块事实、任务执行记录和剩余发布风险；不自动 commit/push。
7. Characters 将会话史、社交批量和最新角标绑定到当前路由关键视觉结算；为图片兜底补 timeout 终态，并区分自动推荐与手动换批超时。
8. Profile 将钱包、首帧后数据和近视口服务数据分级；给现有 check-in/invite/community hooks 增加兼容默认值的 `enabled`，Profile 红点只观察 BottomNav 共享缓存。
9. 调整既有测试并复跑 Frontend typecheck/test/lint/build、`@roleplay`、`@profile`；把本地验证与生产发布后验证分开记录。
