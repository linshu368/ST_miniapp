# 设计

## 复用调研

| 现有能力                                                                 | 位置                                                       | 处理                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------- |
| 嵌入式播放器（上下滑换剧、观看完整短剧）                                 | `components/drama/drama-home.tsx` + `DramaPlayer embedded` | 复用为放映页，不改播放逻辑                   |
| 点击时冻结列表队列 `browseQueue`                                         | `lib/api/drama.ts` `usePrefetchDramaPlayback`              | 复用：放映页读取冻结队列，详情页已在用       |
| 点击即取址 `startDramaPlayIntent` + `dramaTiming.beginPlayback('cover')` | 剧场 `DramaLink`                                           | 复用，owner 改为 `home` 以便嵌入式播放器接上 |
| 剧场滚动恢复 `browse.scroll` / `restoreFloor`                            | `app/(main)/dramas/page.tsx`                               | 扩展：返回聚焦卡片时补足渲染数量             |
| 底栏 `NAV_ITEMS` / `isBottomNavHidden`                                   | `components/nav/bottom-nav-shell.tsx`                      | 改数据，不改样式                             |
| 角色栏目记忆 `readRoleplayView/rememberRoleplayView`                     | `lib/roleplay-navigation.ts`                               | 删除（拆栏后无用）                           |

拒绝：把放映做成剧场页内浮层（需要重做 Telegram 竖滑接管、评论 Provider、页面 ready 与播放埋点路由，并会影响正在进行的 Cloudflare 播放 AB 分母）；卡片到全屏的共享元素放大动画（跨路由需要全局克隆层，收益不抵复杂度，本轮不做）。

## 方案

- **路由**：`/watch` 保留为放映页，只是不在底栏；剧场是唯一入口。`(main)/layout.tsx` 的竖滑接管、`route-query-isolation`、埋点路由全部不变。
- **队列**：`DramaHome` 优先用挂载时 `browseQueue` 缓存快照（剧场点击时写入），没有时（深链/冷启动）退回目录。封面点击写入当前可见列表；「随便看看」写入全量目录。
- **起始剧**：两种入口都写 `browse.activeId`；放映页按 activeId 定位，不在队列时从第一部开始（现有逻辑）。
- **返回聚焦**：store 增加非持久字段 `feedReturnId`。放映页卸载时写入当前 activeId；剧场页挂载恢复滚动后读取并清空，若卡片不在可视区则滚到居中，并对该卡做一次金边淡出。渲染下限纳入该卡索引。
- **底栏**：`NAV_ITEMS` 改为剧场/对话/秘境/创作/我的；`/watch` 始终隐藏底栏；秘境入口固定 `/characters`，在本页再点回顶部；对话入口在本页再点回顶部。后台预热候选与 `PrimaryNavigationRoute` 去掉 `/watch` 加 `/chats`。
- **角色顶栏**：`RoleplayHeader` 只渲染当前栏目名，保留原选中样式与「创作角色」按钮。

## 可靠性

纯前端路由与展示调整，无新接口、无新请求、无持久化格式变化（`feedReturnId` 不落盘；`browse` 结构不变）。失败路径：browseQueue 缺失 → 目录；目录失败 → 放映页现有错误/重试；聚焦卡不存在（下架/筛选变化）→ 只恢复原滚动。旧 sessionStorage 中的 roleplay view key 不再读取，无需迁移。

## 演进与回滚

前端单次发布；回滚即回滚前端部署。`/watch` 地址与埋点不变，Grafana 看板无需改动；`cover` 开播的 route 从 `/dramas/:id` 变为 `/watch`，看对比时注意。

## 追加设计（2026-11-13）：按 cookie 选择落地页

- **判断位置**：`next.config.mjs` redirects 增加一条带 `has: cookie st_landing=chats` 的 `/ → /chats`，排在默认 `/ → /characters` 之前。前端部署在 Vercel，带条件的 redirect 在边缘逐请求判断、不缓存；仍是原来那一次 307，不新增跳转。已核实 Telegram 入口是 `/`：Sentry ST-MINIAPP-48 样本 `document_redirect_count=1`、route `/characters`。
- **写入方**：`lib/landing-route.ts` 的 `rememberChatLanding`。全量会话列表（不带 character_id）按 `total>0` 写/清；会话详情 `message_count>0` 时写（新用户发完第一句、详情重拉即生效）。值未变不重写；一年有效，SameSite=Lax，https 下 Secure。
- **拒绝的方案**：客户端读 localStorage 再 `router.replace`（先下载大厅、多一次切换闪烁）；服务端查库判断（initData 在 hash 里，边缘拿不到身份）。
- **已知边界**：网页版 Telegram 在跨站 iframe 里，cookie 可能写不进或不随请求发送，退回大厅；同一设备切换 Telegram 账号时可能落错一次，读到列表后自动纠正。判断失误的代价只是落到另一个一级页面。
- **启动性能**：`/chats` 加入早期原生 ready 路径，启动框架画对话页骨架（与真实页头/行对齐）；对话页在列表结算后 `markCriticalSettled`。
- **秘境**：删除 `RecentConversationCard` 及其 `recentConversation/recentDetail` 计算；会话列表 query 仍保留给「聊过」标记。
