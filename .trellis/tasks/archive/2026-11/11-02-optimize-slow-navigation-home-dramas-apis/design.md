# 技术设计

## 1. 边界与数据流

### 1.1 一级导航后台预热

`BottomNav` 在 pathname/角色栏目稳定后等待 `afterEntryBackground()`，检查页面可见、在线、非 save-data/2g，然后按当前栏目生成最多两个高概率下一跳。每次只在 idle 回调中预热一个，批次间留出间隔；路径变化或组件卸载时取消尚未执行的调度。

预热仅调用 `router.prefetch`，不启动业务 query。首页与 `/dramas` 随后挂载时继续从相同 `dramaKeys.list()` 和持久目录读取，不建立第二份缓存。

### 1.2 剧场分批挂载

筛选结果仍是完整 `filteredDramas`，只将 `slice(0, effectiveLimit)` 交给 React 挂载。卡片的播放 queue 仍传完整结果，避免进入详情后上下剧顺序被截断。

首批为 12（覆盖当前两列固定场景的完整首组），后续每批 10。返回滚动时根据已保存 scroll 和卡片固有高度估算 `restoreFloor`，额外保留一屏尾部；`effectiveLimit = max(renderLimit, restoreFloor)`。筛选/排序/关键词变化时重置批次，IntersectionObserver 在底部 400px 前继续扩容；无 observer 的旧 WebView 一次性展示全部作为兼容降级。

### 1.3 消息中心有条件预取

通知 API 层提供单一 list query options，`useNotificationsQuery` 与 `prefetchNotifications` 共用 key、queryFn、刷新和轮询配置。个人页在 background 阶段且 unread 对应分类大于 0 时：

1. 预取 `/profile/messages` route；
2. 预取有未读的 official/personal 列表；
3. 消息中心挂载时立即消费缓存，并保持 stale=0、always refresh 和原轮询，缓存不替代服务端事实。

## 2. 可靠性设计

- 超时/重试：不改变统一 API client 的有限 GET 重试；route prefetch 失败由 Next 自行降级为点击加载。
- 幂等：路由与 GET query 预取均无写入；重复调用由 Next/React Query 缓存合并。
- 并发/容量：路由预热串行、最多两个；通知只预取有未读分类，最多两个；不扩大业务写并发。
- 取消：导航调度在 pathname 改变和卸载时取消；React Query 继续传递 signal，页面离开可终止请求。
- 降级：低速/离线/后台不预热；IntersectionObserver 缺失则完整渲染；预取失败不阻断真实导航。
- 事务/补偿/限流：本轮无写入和跨系统事务，不适用；现有请求队列与后端限流保持不变。
- 可观测性：继续使用现有 page-ready、drama timing 和 Sentry navigation；不新增高基数事件。

## 3. 最小充分方案

- 不新增文件层级、状态源、依赖或公开 API。
- 导航逻辑留在 BottomNav，剧场批次留在页面，通知 query 配置留在 API 层。
- 拒绝通用 preload manager、虚拟列表依赖、数据库 RPC 和播放签名预取。

## 4. 兼容、发布与恢复

- 无契约、数据库和环境变量变化，可与现有 Backend 独立发布。
- 旧浏览器缺少 idle/IntersectionObserver 时采用定时或全量渲染降级。
- 停止条件：本地出现返回滚动丢失、播放 queue 截断、低速网络仍预热或消息轮询语义变化时停止发布。
- 回滚：三个改动点互不依赖，可分别撤回导航调度、剧卡批次或通知预取，不需要数据回滚。

## 5. 验证策略

- 现有 Frontend test/typecheck/lint/build。
- `pnpm test:ui --grep @drama`：列表、筛选、详情返回、首页与播放错误场景。
- `pnpm test:ui --grep @profile`：个人页、消息入口与未读显示。
- 人工使用 DevTools slow-2g/save-data 检查无后台 prefetch；正常网络检查首屏后最多两个 route prefetch。
- 发布后按相同窗口复查 `/`、`/dramas`、`/profile/messages` navigation P95；本地结果不替代生产样本。
