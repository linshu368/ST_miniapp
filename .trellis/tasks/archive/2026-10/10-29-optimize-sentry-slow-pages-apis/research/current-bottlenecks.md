# 当前瓶颈调研

## 证据基线

固定报告：`D:/JobExe/ST/sentry/2026-10/2026-10-29  3点前.md`，时间窗 2026-10-28 15:00 至 2026-10-29 15:00（Asia/Shanghai）。

| 对象                            | P95 / 样本    | 结论                                                                       |
| ------------------------------- | ------------- | -------------------------------------------------------------------------- |
| `/chat/:characterId` navigation | 12.19s / 250  | 页面入场最慢；需同时看 route JS 与 session detail，而非只看 backend detail |
| `/` navigation                  | 8.14s / 40    | backend drama API 不慢，媒体/客户端瀑布更可疑                              |
| `/` pageload                    | 28.38s / 180  | 不能由 drama API P95 解释，需保留媒体首帧诊断                              |
| `/characters` navigation        | 5.55s / 340   | backend characters 约 0.14s，主要在代理、请求竞争、渲染与图片              |
| POST messages                   | 45.24s / 1.6k | 完整 SSE 生命周期；不能当首字等待                                          |
| POST regenerate                 | 32.28s / 195  | 同上；应由 client-visible first-token 单独验收                             |
| GET support/unread              | 1.26s / 120   | 跨仓客服代理链路；需拆 identity 与 upstream                                |

报告窗口 15k server spans 无 4xx/5xx；provider `internal_error` 共 555，其中 OpenRouter + Venice 占 93%。这些错误属于现有 first-token/fallback 治理，不授权本任务重写 provider 或计费链路。

## 当前工作树与重叠范围

- `10-28-sentry-cross-layer-performance-optimization` 已实现请求并发槽、drama list/playback 并行、图片广场与部分观测，T4 页面分波仍为 Todo。
- 多个进行中任务正在修改 first-token、fallback、可恢复投递、drama 诊断与角色社交。当前 `generate.ts`、chat page、gallery、drama files 已有用户变更，本任务只做可独立叠加的最小改动。
- 当前生产构建（2026-10-29，本工作树）：`/` 283 kB 首载、`/characters` 271 kB、`/chat/[characterId]` 396 kB；chat 路由独占 101 kB，明显高于其它路由。

## 复用调研

| 类别           | 已检索位置                                               | 决策                                                             |
| -------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| REST/超时/重试 | `frontend/src/lib/api/client.ts`、`request-timing.ts`    | 扩展现有 client；不新增 HTTP wrapper                             |
| 请求并发与取消 | `request-concurrency.ts`、`route-query-isolation.ts`     | 复用现有槽与 React Query cancellation；不新增 route epoch 状态源 |
| Query defaults | `query-client.ts`                                        | 关闭叠加 retry，由 API Client 维持一次 GET transport retry       |
| 角色列表缓存   | `characters.ts` localStorage + idle persist              | 保留；只传 signal、去重复调度                                    |
| 会话列表/详情  | `conversations.ts`、`use-chat-session.ts`                | 复用现有 query keys/cache；RecentConversationCard 改消费父层数据 |
| 页面阶段       | `entry-phase.ts`、`page-ready.ts`                        | 保留现有 P0/enrich/background；不新建性能 store                  |
| chat 可选 UI   | `ChatSessionDrawer`、`CharacterDetailSheet`、媒体 footer | 用 Next dynamic import；正文/输入框保持同步 chunk                |
| drama 可选 UI  | `DramaCommentsProvider`、`DramaCommentSheet`             | 拆轻量 context 与懒加载 sheet；播放器不延后                      |
| support        | `support.ts` hooks/routes、`cs-service.ts`               | 保留 5s timeout 和权威上游；只减少重复读、补阶段日志             |
| 用户身份       | `backend/src/lib/user.ts`                                | 已有 60s/5000 项/inflight 去重，继续复用；不再建缓存             |
| 数据库         | conversation/detail、character API 当前 P95 与代码       | 无数据库迁移证据；不创建索引/RPC/表                              |

## 具体可避免成本

1. characters、conversations、support 多数 queryFn 未接收 React Query `signal`，离页取消无法到达 `fetch`；lobby 同源 route 上游也没有显式 timeout。
2. API Client GET 已重试最多一次，而 QueryClient 默认 `retry: 1`，极端情况下会叠加到最多 4 次传输尝试。
3. CharacterGallery 已订阅全量会话用于“聊过”标记，但 RecentConversationCard 再订阅一次同 key，并为 recent 角色额外请求详情；角色摘要已在父层列表中。
4. CharacterGallery 在 `<img fetchPriority=high>` commit 后又通过 effect 为相同 URL 创建 preload link，时机过晚且重复调度。
5. chat 页面把默认关闭的角色详情和会话抽屉放进 101 kB 独占 route chunk；characters 同样同步包含角色详情面板。
6. main layout 静态导入的 drama comment module 同时包含完整查询、表单和 sheet；评论未打开时也进入播放路由的初始依赖图。
7. support unread `staleTime=30s` 但 `refetchOnMount='always'`，会绕过有效缓存；后端没有拆分身份与客服上游耗时，无法判断 1.26s 的归属。

## 不采用的方案

- 不缓存 support unread 结果：会放大多设备已读延迟，且缺少失效事件。
- 不缩短 SSE 生成内容或强制更短总超时：45s/32s 是完整流，不是首字指标。
- 不新增 BFF 聚合接口、通用调度框架、Redux、消息队列或数据库对象。
- 不整体 lazy load `DramaPlayer`：首页立即播放，额外 chunk 往返会延迟播放地址与首帧。
- 不在证据不足时改 provider routing、fallback、billing、quota 或数据库索引。

## Supabase 结论

已检查 2026-10-29 可用的 Supabase changelog；与本任务相关的最新数据库 breaking change 是 PostgreSQL 15.19/17.11 对部分扩展/索引的升级提示。本任务不创建或修改数据库对象，也不使用 Supabase MCP 读取业务行，因此不触发 migration、RLS 或生产结构操作。
