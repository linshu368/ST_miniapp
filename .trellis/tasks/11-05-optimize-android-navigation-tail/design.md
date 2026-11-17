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

## 7. 第二阶段最小充分方案（2026-11-06）

### 7.1 复用与拒绝项

- 复用 `timedFetch` 的全阶段 deadline、`MobilePerformancePolicy` 的平台分组、React Query 取消/去重、现有角色 localStorage 快照与 `secondaryReadsReady`。不新增 HTTP client、全局状态机或 Profile 聚合接口。
- 复用 Backend `/api/characters?sort=latest` 已返回的 `public, max-age=60, s-maxage=60, stale-while-revalidate=60`，代理只做白名单透传；不为 `recommended` 发明边缘缓存，因为其公共冷启动排序允许重排，且个人批次绝不能进入公共缓存。
- 不把页面 ready 提前到骨架，不用“2 秒后报错”冒充成功达标；缓存/公共首屏必须实际有可交互角色卡才算 content-ready。无缓存且网络失败时明确 error 作为独立 terminal。
- 暂不做 Profile 聚合 API、Service Worker、全站资源缓存、数据库重构或通用自适应并发框架。Railway 同期容量和 handler 时长不支持这些作为第一步。

### 7.2 `/characters` 路径

1. 自动推荐在 450ms 启动已有/公共首屏 hedge；迟到个人批次继续在原 5 秒有限预算内完成，只写下一次可复用缓存，不重排当前视口。不得中止该幂等请求，否则会丢失已由服务端推进的批次并破坏返回一致性。
2. Android 目录/公共首屏的 `timedFetch` 预算为 1.8 秒，iOS/other 仍为 20 秒。Android timeout 不在 React Query 叠加重试。
3. `latest` 浏览器请求允许共享缓存，Next proxy 仅在成功且无 selection 时透传 Backend 的公共 60 秒策略；其余响应强制 `no-store`。
4. 无 selection 的 public head 成功后写独立 `miniapp:lobby-public-head` 快照，idle 执行；读取时校验年龄与数组。指定 ID 校准永不复用该快照。

### 7.3 `/profile` 路径

继续使用已实现的 Android navigation quiet window。把 VIP 展示组件改为按需加载，并且在 `secondaryReadsReady` 前只渲染同尺寸静态占位；次级 chunk 不参与 route chunk 的首轮下载/解析。钱包、身份、充值、消息和客服链接不依赖该 chunk。

### 7.4 可靠性、恢复与发布

- timeout：自动推荐显示路径 450ms 后由公共首屏接管，个人/手动推荐请求预算 5 秒；Android 目录 1.8 秒、非 Android 目录 20 秒。浏览器冻结会暂停 JS timer，因此冻结样本通过 visibility/trace 单列，不能声称物理硬实时。
- retry：POST 推荐仍不自动重试；GET 同源目录不额外叠加重试。手动 retry 复用原按钮。
- 幂等/并发：推荐 request UUID、React Query key 和在途去重保持；独立 head 快照同 sort 只保留最后一次 idle 写入。
- 降级：持久 head → 公共 head → 明确错误；任何 cache 解析/写入失败只退回网络，不阻断页面。
- 容量：latest 边缘缓存减少 Railway 请求；不得增加请求数。发布后如果客户端请求量、stale 数据投诉、terminal/stall 或 iOS P95 恶化，停止放量并回退本阶段提交。
- 发布顺序：先合并 Frontend；以 release 隔离观察 10%/50%/100%（发布平台不支持百分比时使用 Preview/TEST 真机后一次发布并保留即时回滚）。同 release 连续两个 24h 窗口通过才关闭任务。
