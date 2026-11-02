# 性能证据与复用调研

## 报告证据

- 2026-10-31：`/` 导航 P95 8.42s，`/dramas` 6.49s，`/characters` 6.31s，`/profile/messages` 14.16s。
- 2026-11-01：`/` 导航 P95 5.62s，`/dramas` 2.08s，`/characters` 4.84s，`/profile` 7.22s。
- 两日报告中的普通短剧/角色读取接口没有与页面导航同量级的 P95；页面慢更符合 route chunk、图片与同步挂载长任务。
- 10-31 消息列表接口曾出现 4.74s P95；消息中心默认首屏为 official，适合在个人页确认有未读后后台预取。
- 首页 pageload 样本量跨日变化很大，不能将 11-01 的 17.16s 直接作为稳定回归结论。

## 已检索并复用

- `components/nav/bottom-nav.tsx`：现有 intent prefetch 与网络条件判断；扩展为首屏后的有限后台预热，不恢复 viewport 自动全量预取。
- `lib/entry-phase.ts`：复用 `afterEntryBackground()`，保证预热不与冷启动 P0/enrich 竞争。
- `components/characters/character-gallery.tsx`：复用有限首批、每批 10 张、IntersectionObserver 提前 400px 的成熟列表模式；剧场首批取 12 以覆盖现有两列固定场景。
- `lib/api/drama.ts`：`/` 与 `/dramas` 已共享 15 分钟目录缓存和本地持久快照；继续复用，不新增数据源。
- `lib/api/notifications.ts`：抽取同一 query options 供 hook 与 profile 预取共用，避免复制请求配置。
- `app/(main)/profile/page.tsx`：已持有 unread 数据和 QueryClient，是按分类决定是否预取的最小落点。

## 不采用

- 不改 `/api/dramas` repository：报告没有指出该接口长尾，且前端已缓存；改数据库 shape 缺少生产证据。
- 不新增 notification RPC/migration：消息中心可以先通过有条件预取降低可感知等待，数据库方案会增加发布顺序和回滚成本。
- 不修改 creator polish 模型或输出长度：它是独立产品质量权衡，不属于首页/剧场导航的最小充分方案。
- 不预取 `/api/dramas/:id/play`：签名和 CDN 路径必须在真实播放意图时确认。
- 不全量恢复 Next Link 自动预取：此前已确认会在移动端冷启动争抢网络与解析资源。

## 当前工作树边界

以下既有修改属于上一任务，只读保留：Backend conversations SSE、perf-metrics 及对应测试/路由；本任务不得覆盖或整理这些 diff。
