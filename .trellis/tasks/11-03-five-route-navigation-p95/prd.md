# Optimize five-route mobile navigation readiness

## Goal

让底部导航点击进入 `/`、`/dramas`、`/characters`、`/creation`、`/profile` 后，Android 与 iOS 的真实主内容可见 P95 目标均不超过 2 秒，并建立同口径的 Grafana 长期对比记录。

## Requirements

- 计时起点为用户对底部导航链接的真实点击/导航开始，终点为目标页面已提交可交互的主要内容；占位骨架不得作为内容就绪。
- 五个路由共用 `page.navigation` 低基数指标，必须包含 route、Android/iOS、release、foreground、cache、2 秒预算结果等可聚合维度。
- `/creation` 补齐与其它一级页面一致的就绪、失败/离页/卡住终态；`/profile` 的页面就绪不得被非阻塞的余额请求错误地绑死，但余额失败仍保留自身错误和重试 UI。
- 导航意图阶段复用 React Query 缓存预取主数据；重复意图由 QueryClient 去重，不直接在组件内散落 fetch，不预取 mutation，不修改外部契约。
- Android 优先降低 `/characters`、`/profile` 的冷导航长尾；iOS 优先降低 `/profile`、`/characters`，同时保持 `/`、`/dramas` 已达标路径不回退。
- Grafana 提供五路由 Android/iOS P95、2 秒达标率、样本量和失败/卡住终态；低样本和无数据必须可见，不能只展示成功耗时。
- 不新增依赖，不改变页面业务功能，不用更早的骨架时间替代真实内容时间。

## Acceptance Criteria

- [ ] 五路由 SPA 点击均产生 `page.navigation`，`/creation` 不再落入 `other` 或无样本。
- [ ] `page.navigation` 带 `readiness_budget=within_2s|over_2s`，计算值与同条 `duration_ms` 的 2000ms 边界一致。
- [ ] 五路由明确的 pointer/touch/focus intent 会预取目标 route chunk 与对应主 query，已有新鲜缓存不重复请求。
- [ ] `/creation` 以真实可交互的创作入口为 content ready，收藏列表继续独立加载；`/profile` 以真实头像/编辑/入口 shell 为 content ready，余额继续独立加载并可失败重试。
- [ ] 仓库内 Grafana dashboard 可导入且查询只覆盖这五个 route；若当前连接无写权限，明确记录待导入步骤，不能声称线上已更新。
- [ ] 通过 Frontend typecheck、现有相关测试、lint、build，以及 `@drama`、`@roleplay`、`@profile` 适用 UI 回归。
- [ ] 发布后按 release 分 Android/iOS 复测：每组至少100个成功终态且同时检查 page.stall/page.terminal；P95 超过2秒或错误/卡住率上升时停止扩大并回滚预热或 forward-fix。

## Android/iOS 性能 P95 门禁

- 受影响页面：`/`、`/dramas`、`/characters`、`/creation`、`/profile`
- 受影响接口：`GET /api/dramas`、`GET /api/lobby-characters?sort=latest`、`GET /api/favorites`、`GET /api/wallet/balance`
- Android 页面加载 P95：最慢基线 `/profile` 4716.73 ms / 各路由目标 2000 ms
- iOS 页面加载 P95：最慢基线 `/profile` 2690.8 ms / 各路由目标 2000 ms
- 接口 P95：受影响聚合最慢基线 iOS dramas 3857.6 ms / 页面预热后用户等待目标 2000 ms；不把接口本身已达标作为代码阶段结论
- 数据来源与观测窗口：Grafana Cloud Loki production `engineering_v1`，2026-10-27 18:00 至 2026-11-03 18:00 Asia/Shanghai（7d），详见 `research/baseline-and-reuse.md`
- 发布后验证、无可见样本/低样本及不适用说明：`/creation` 当前无样本，`/` iOS N=27、`/dramas` iOS N=92 为低样本；发布后按 release 连续两个完整24h窗口，单组不足100延长观测，联合检查成功、失败、离页和 stall。

## Notes

- 用户输入的 `/**dramas` 按现有真实一级路由 `/dramas` 处理。
- “保证 2 秒”作为发布验收目标；代码与本地 fixture 只能降低风险并建立可验证口径，不能替代生产样本。
