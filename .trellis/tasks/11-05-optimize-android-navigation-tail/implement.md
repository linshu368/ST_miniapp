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

## 第二阶段执行计划（2026-11-06）

8. 在 mobile policy 增加 Android 角色目录 1.8 秒预算，接入 `fetchCharacters`；保留自动推荐 450ms 公共首屏 hedge 与迟到批次缓存，个人/手动推荐请求保留 5 秒有限预算。
9. 为无 selection 的公共推荐首屏增加独立持久快照；latest 请求允许缓存，并在 Next proxy 白名单透传 Backend 已有 60 秒公共缓存头。
10. 将 Profile 的 VIP 非关键展示改为 `secondaryReadsReady` 后按需加载，保留同尺寸占位与所有关键入口。
11. 扩展 mobile policy、lobby proxy 与推荐降级相关回归；复用 `@roleplay @lobby-rotation`、`@profile` 和 Android 五入口场景。
12. 发布后按同 release 查询 `/characters`、`/profile` 的 Android click→content-ready P95/2秒率/p99，以及 terminal/stall/error/page_left、API 请求量和 iOS 保护线；Grafana OAuth 恢复前任务不得归档。
