# 技术设计

## 1. 范围与现状证据

链路为 `BottomNav intent/click -> Next route chunk -> PagePerfTracker/usePageReady -> 页面 P0/次级 React Query -> 后台 route 预热`。生产 7d 五入口 `page.navigation` 显示 Android P95 4067.06ms、iOS 2078.4ms；Android `/profile` P95 5278.4ms。当前 `entry-phase` 是启动期一次性状态，首次 background 放行后 SPA 导航不会重新关闭；BottomNav 的未读/客服、Providers settings、Profile 次级查询及 route 预热因此可能在后续导航提交/绘制前并发启动。

## 2. 复用调研

- 导航：复用 `BottomNav` 的真实点击与 intent、`usePageReady` 的真实 content ready/failed，不建立第二套路由计时器。
- 平台：复用 `getTelegramPlatform`、`mobilePlatformGroup` 和 `MobilePerformancePolicy`，Android X 与 Android 归为同组。
- 启动分波：保留 `entry-phase` 负责文档冷启动；新增的导航安静状态只管 SPA 五入口，避免把一次性启动状态改成复杂路由状态机。
- 页面 P0：保留 Characters critical query、Profile wallet、Drama 页面现有数据所有权；只门控明确的次级读取。
- 后台条件：继续复用 `canPrefetchInBackground`、React Query query key/in-flight 去重和现有首帧/近视口 gates。
- 已检索但不扩展：Backend routes/repositories、shared contracts、数据库函数、API timeout/retry、Sentry/Grafana 指标定义。它们不是本次 Android 公共调度根因。

## 3. 最小实现

新增一个小型内存调度器 `navigation-quiet-window.ts`：

1. 仅 Android/Android X 且目标属于一级入口时，BottomNav 有效点击调用 `beginNavigationQuietWindow(target)`。
2. `usePageReady` 在 content ready 或 failed 的已提交 effect 中调用 settle；调度器等待双 `requestAnimationFrame`，再取一次 idle 机会（带短 timeout）后释放。
3. 若 route chunk/页面挂载/ready 永不完成，4 秒 fallback 强制释放；新导航使用递增 generation，旧 frame/idle/timer 不能释放新导航。
4. 提供 Promise 和 React hook 两种只读消费方式。BottomNav route 预热等待 Promise；未读/客服、Providers settings 与 Profile 次级查询使用 hook gate。
5. Android policy 增加后台预热上限 1；iOS/other 保持 2。Android touch intent 仅预取 Characters 的 P0 数据，其余只预取 route chunk。

不修改 `page.navigation` 起点或终点。调度器不依赖遥测是否启用，因此不会出现关闭 Grafana 后性能策略失效。

## 4. 可靠性设计

- 超时：安静窗口 4 秒硬兜底；idle 最多额外等待 500ms。API 原 20 秒/长任务预算不变。
- 重试：不新增。GET 仍由 API client 最多一次安全传输重试；route prefetch 仍由 Next 管理。
- 幂等/并发：begin/settle 按 generation 幂等；React Query key 和在途去重不变。无业务写入。
- 事务/补偿：不适用，无数据库或关键写入。
- 降级：非 Android、非五入口、缺少 rAF/idle、计时器异常均恢复原行为或用短 timer 释放；不能阻止页面 P0。
- 限流/容量：Android 每轮 route 预热由 2 降至 1，请求总量只减不增；延后的查询仍受现有并发帽和可见/在线条件约束。
- 可观测性：沿用 page ready/terminal/stall 和 API queue/total。安静窗口本身不新增高基数事件，避免为优化再制造遥测开销。

## 5. 演进与恢复

- 兼容：无契约、URL、缓存 key、视觉或数据 shape 变化；iOS/other 保持原调度。
- 发布：Frontend 单独发布即可。先按 release 比较 Android/iOS；每组 N<100 不下结论。
- 停止条件：Android page terminal/stall 上升、P0 请求被延迟、Profile 次级内容长期缺失、iOS/普通请求 P95 回退 >5%、后台工作在 4.5 秒后仍未恢复。
- 回滚：单独回退导航调度器及三个消费点即可；无需 Backend/DB 回滚。也可先将 Android prefetch limit 恢复 2，保留安静窗口继续观察。

## 6. 可验证性

- 调度器：Android 启用、iOS 不启用、ready 后 paint+idle 释放、4 秒 fallback、旧 generation 不释放新导航。
- BottomNav/policy：Android 上限 1，iOS/other 上限 2；Android intent 不预取非 P0 数据。
- 页面接线：`usePageReady` ready/failed settle，cleanup 不伪结算；Profile wallet 不受 gate，次级 hooks 受 gate。
- 命令：Frontend typecheck/test/lint/build、complexity、diff check；复用 `@profile` 和五入口/roleplay 现有 UI 场景。真机与生产 P95 只在发布后验证。
