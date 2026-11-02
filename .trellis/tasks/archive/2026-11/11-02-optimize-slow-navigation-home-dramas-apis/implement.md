# 执行计划

1. 扩展 BottomNav：复用 entry background 与网络门禁，按当前路由串行预热最多两个下一跳；保证清理 timer/idle callback。
2. 优化 `/dramas`：引入首批/分批挂载、返回滚动 floor 与旧 WebView 降级，保持完整 queue 和关键封面计时。
3. 复用 notification query options，在 `/profile` 有未读时后台预取消息路由和对应分类数据。
4. 运行格式检查并审阅 diff，确认未触碰既有 Backend SSE 工作树变更。
5. 依次运行：
   - `pnpm --filter @miniapp/frontend test`
   - `pnpm --filter @miniapp/frontend typecheck`
   - `pnpm --filter @miniapp/frontend lint`
   - `pnpm --filter @miniapp/frontend build`
   - `pnpm test:ui --grep @drama`
   - `pnpm test:ui --grep @profile`
6. 记录无法在本地验证的 Telegram 真机和生产 P95 风险，检查模块知识更新，自动归档任务但不提交、不推送。

## Review gates

- 实现前：范围仅为 Frontend，报告无证据的 Backend/DB/模型改动排除。
- 实现后：检查路由预热数量/网络门禁、剧场滚动恢复、通知分类条件和 Query key 一致性。
- build 后：确认首页与 `/dramas` route 正常产出，未出现静态渲染或类型回退。

## Rollback points

- 导航预热、剧场分批、通知预取分别独立回滚；任一失败不阻塞其他两项验证。
