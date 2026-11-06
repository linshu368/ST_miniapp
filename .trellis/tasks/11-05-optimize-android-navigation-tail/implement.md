# 执行计划

1. 新增 Android 五入口 SPA 导航安静窗口，包含平台/路由筛选、generation、4 秒 fallback、paint+idle 释放及 React/Promise 读取入口。
2. 在 BottomNav 有效导航点击开始窗口；后台 route 预热等待释放，并按平台使用预热上限。
3. 调整 intent 数据预取：Android 只保留 Characters P0；iOS/other 保持既有行为。
4. 在 `usePageReady` 的 content ready/failed commit 后结算窗口，不改变原 Sentry/Grafana ready 口径。
5. 将 BottomNav 未读/客服、Providers settings、Profile 首帧后和近视口次级读取接入 gate；钱包及用户主动操作不接入。
6. 增加/扩展既有 Vitest 回归，运行 Frontend typecheck/test/lint/build、complexity 与 diff check。
7. 更新 `docs/performance` 修改清单、模块事实与任务执行记录；记录生产发布后按 release/platform 的验收查询和回滚点，不自动提交或 push。

## 验证命令

```powershell
pnpm --filter @miniapp/frontend exec vitest run src/lib/navigation-quiet-window.test.ts src/lib/perf/page-ready.test.ts src/lib/mobile-performance.test.ts
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm lint:complexity
git diff --check
```

## 回滚点

- 可先回退 BottomNav/Providers/Profile gates，调度器无消费者即无业务影响。
- Android route 预热上限可独立恢复为 2。
- 不涉及 Backend、shared、数据库或环境变量。
