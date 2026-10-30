# 实施计划

## Phase 1：Frontend 关键路径

1. 收敛角色首屏高优先级头像数量，保持首卡关键视觉回调。
2. 将 wallet 查询声明为 critical；运行 payment/client 相关测试。
3. 允许 config query 受控启用，在 Create feed 结算后预热；验证 Studio 缓存命中与失败态。
4. 动态加载选集 Sheet，以播放器现有按钮显式打开；不改变播放请求、续播和手势。

## Phase 2：Backend 流式链路

1. 在 `streamTurn` 中并行 catalog 与身份映射，随后校验配置剩余预算和 session ownership。
2. 把富回复诊断从 `done` 后同步等待改为 best-effort 异步执行。
3. 更新现有后处理测试的异步断言，并运行 conversations/generation 相关测试。

## Phase 3：验证与交付

```powershell
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm test:ui --grep @roleplay
pnpm test:ui --grep @profile
pnpm test:ui --grep @drama
git diff --check
```

若完整 UI 组受环境/时长限制，至少运行相关 fixture tests，并在 verification.md 记录未覆盖的 Telegram 真机、真实供应商和 production release 验证。

## 发布后验证

- 同一 production release 分别观察 document/SPA、样本量、p50/p95，不跨 release 平均。
- `/characters`、`/profile`、`/create/studio/:id`、`/`、`/dramas/:id` 至少收集 24 小时；页面错误率不得上升。
- 聊天同时展示首字分布、完整回复分布、系统无首字截断率和 provider/internal_error；不能只用完整流 P95 判断首字体验。
- 目标收益：受影响页面 P95 相对 10-30 基线下降且样本量充分；未达到时保留证据，不以本地构建宣称达标。
