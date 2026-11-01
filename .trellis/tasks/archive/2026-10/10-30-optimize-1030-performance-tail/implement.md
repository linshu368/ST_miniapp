# 实施计划

## Phase 1：候选验证

1. 检查 production build 中 React Query Devtools 的真实产物；若仅为 production null stub，则保持现状。
2. 记录候选被拒绝的构建证据，不以源码 import 形式直接推断 bundle 成本。

## Phase 2：导航与 Profile

1. BottomNav Link 全部关闭框架视口自动预取，保留既有显式意图预取和网络保护。
2. Profile 的 CommunitySheet 动态加载，首次打开后保持挂载。
3. 扩展现有 `@navigation` 场景验证首次打开与关闭，不新建测试文件。
4. 不修改查询 enabled、轮询、页面 ready 和业务状态。

## Phase 3：验证

```powershell
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm test:ui --grep @roleplay
pnpm test:ui --grep @profile
git diff --check
```

如完整 UI 组受本地首次编译或工具时限影响，定向复跑失败场景，并在 `verification.md` 区分应用失败、开发态首次编译和环境问题。

## 发布后验证

- 固定同一 production release 至少 24 小时，按 Telegram Android 单独比较 `/characters`、`/profile`、`/`、`/dramas/:id` 的 count/P50/P95 和错误率。
- 同时观察 `startup.shell_ready.duration`、chunk load errors 与资源 waterfall，确认收益来自减少非目标下载，而不是样本结构变化。
- messages/regenerate 继续按 provider/model/token/回复长度观察完整生成长尾；本轮不把它列为前端 bundle 优化收益。
