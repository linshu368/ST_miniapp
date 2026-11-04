# 技术设计

## 边界与复用调研

复用现有 `markPageNavigationStart`（Link 捕获真实导航起点）、`beginPage`、`usePageReady`、React Query、`BottomNav` intent 和 `mobile-performance.ts`，不新建第二套计时器或状态源。已检索：五路由 page/component、`page-tracker`、`route-template`、`page-ready`、`bottom-nav`、drama/characters/favorites/payment query helpers、既有 Grafana engineering dashboard。未发现 `/creation` 登记或就绪上报；`/profile` 当前把整个页面 ready 绑到余额网络结果。

## 方案

1. 将 `/creation` 加入工程路由白名单，并在真实创作入口 shell commit 后上报 content ready。收藏列表是页面下半区的独立 server state，不阻塞创作按钮、图片入口和栏目导航。
2. `/profile` 以已经真实渲染且可交互的头像、编辑入口和功能入口 shell 为 content ready；余额维持独立加载/错误/重试，不把 `—` 当余额内容，也不把余额失败变成页面整体失败。这样修正的是“页面内容显示”口径，不删除慢样本。
3. `page.navigation` 在记录 duration 时增加由同一 duration 计算的 `readiness_budget`。只允许 `within_2s`/`over_2s` 两值，避免高基数；失败、离页、stall 继续由 `page.terminal`/`page.stall` 观察，防止成功样本幸存者偏差。
4. characters、favorites、wallet 主 query 导出 QueryClient prefetch helper。BottomNav 的 hover/focus/touch intent 同时拉 route chunk 和对应主 query；QueryClient 自带 in-flight 去重和 staleTime，不新增并发控制器。`/dramas` 只预热 route chunk，继续复用已有目录缓存和页面 query：验收发现意图数据预取会与剧场增量列表挂载形成竞态，而该路由生产页面基线已低于 2 秒。Android 优先预热 characters/profile，iOS 优先 profile/characters；后台仍最多串行两个 route chunk，避免五路由齐射。
5. 新增独立五路由 Grafana dashboard JSON，固定 route 正则，提供 P95、≤2秒比例、样本量、终态分布和时序。保留 environment/release/platform 过滤，不创建高基数 label。

## 可靠性

- 超时/重试：沿用 API client 和现有 query 策略；prefetch 不增加重试层。
- 幂等/并发：仅 GET，QueryClient 按 query key 合并在途请求；重复触摸无额外写入。
- 降级：不支持/不允许重预取时仍依赖正常页面 query；预取失败不会阻止导航，页面原错误 UI 继续生效。
- 容量/限流：只在明确 intent 预取一条目标主 query，短剧不额外预取目录；后台 route chunk 继续上限2且串行，不全量预取五套数据。
- 可观测性：成功耗时、2秒预算、终态、stall 和样本量联合看；`/creation` 首发无历史样本明确显示 no data。

## 最小充分方案与拒绝项

不新增 service worker、离线数据库、全局路由状态机、后端接口或持久化钱包快照。钱包快照可能展示过期余额，风险高于收益；本方案只预取并保留页面 shell 可用。也不复制一套 `route.ready.v2` 指标，避免双报和口径漂移。

## 演进与恢复

新增字段和 route 是向后兼容的；旧 release 没有 `readiness_budget`，看板按新 release 验证。发布先小流量观察 terminal/stall 和请求量，再比较 P95。若预取导致 API 请求量、限流或首路由性能恶化，可单独回退 BottomNav 数据预取；若口径异常可回退 ready 调整但保留 `/creation` 白名单，使用 forward-fix 补正看板说明。

## 验证

既有 perf tracker 测试锁定点击时钟与 route 白名单；API/BottomNav 走现有测试、typecheck、lint/build。UI 至少覆盖 `@drama`、`@roleplay`、`@profile`，手工检查 `/creation` 首屏按钮可操作、收藏仍能加载/失败重试。真实 Android/iOS P95 仅发布后验收。

## 二阶段：`/characters` 与 `/profile` 长尾治理（2026-11-04）

### 复用调研

- `/characters` 继续复用 `useCharactersQuery` 持久缓存、`markPageCriticalVisual`、`useEntryEnrichReady`、批量 `useCharacterSocialsQuery` 和移动端首批渲染预算；不建立第二套角色目录或图片计时器。
- `/profile` 继续复用现有 React Query hooks 与各组件 loading/error/retry；只给已有 hook 补 `enabled`，不把服务端状态复制到本地 store。
- 现有 `page.navigation` 已承担 content-ready SLA，`page.critical_visual` 已能独立记录角色首图，因此本轮不复制事件族；Profile 钱包新鲜时间继续使用 `page.fresh`。
- 生产 trace 显示客户端连接、请求排队、图片和长帧高于多数服务端 handler；因此不新增聚合接口或数据库改动。证据与版本边界见 `docs/performance/profile-characters-long-tail-analysis-2026-11-04.md`。

### 实现设计

1. Characters 保持目录为 P0。当前路由的会话史、社交批量和最新角标额外等待首张关键图成功/失败/无图/超时，避免应用级 enrich 状态在 SPA 导航后已永久放行而重新制造首屏请求竞争。
2. 缓存目录的后台校准继续等待首图；兜底到时同时记录 `critical_visual=timeout`，避免只有成功图片进入视觉分布。
3. 推荐自动 open 读取使用短于手动换批的入场超时；超时后沿现有 query error 降级显示公共目录或已保存批次。手动换批/撤回仍保留 5 秒预算，避免改变用户明确操作语义。
4. Profile 钱包保持立即 critical。签到/VIP/套餐在首帧绘制后启动；设置仅在首帧后或用户打开头像菜单时启动；邀请/社区仅在“服务与帮助”接近 viewport 时启动。消息和客服红点继续由常驻 BottomNav 拥有网络读取，Profile 只观察共享缓存。
5. IntersectionObserver 不可用时安全放行服务入口查询；首帧调度在组件卸载时取消，不能产生卸载后 setState。

### 可靠性、容量与恢复

- 超时与有限重试：推荐自动读取单次、快速失败；手动 mutation 仍使用原 5 秒且无自动重试。其它查询沿用现有 GET 有限重试。
- 幂等与并发：只调整 GET/幂等 open 的启动时机；React Query query key 和在途去重不变。签到写入不延后、不预取。
- 降级：图片不结算走 timeout；IntersectionObserver 缺失直接放行；推荐超时显示现有安全降级内容；Profile 每个业务区保留原 loading/error/retry。
- 容量：减少首帧并发，不增加总请求；可见区域未到达时邀请/社区请求可能完全不发出。
- 回滚：可分别回滚 Profile enabled 分级、Characters 视觉门槛或推荐入场超时，不涉及契约、数据迁移和旧数据。
- 停止条件：发布后若推荐可用率/换批错误显著恶化、服务入口曝光后长时间不出现、API 错误率或 page terminal/stall 上升，停止放量并回滚对应分级。

### 可验证性

- 既有 tracker 测试需覆盖视觉 timeout 终态；推荐 hook 测试覆盖自动入场与手动操作不同超时。
- Profile UI fixture 覆盖延后阶段的 loading、可用和错误；Characters fixture 检查首卡可见前无社交/会话请求竞争。
- 执行 Frontend typecheck、相关测试、lint、build，并复跑 `@roleplay` 与 `@profile`；生产结论仍需新 release、Android/iOS 各 N≥100。
