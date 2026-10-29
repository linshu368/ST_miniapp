# 技术设计

## 1. 设计结论

采用“取消传播 + 单层重试 + 数据复用 + 可选 UI 拆包 + support 阶段归因”的最小方案。页面关键内容、消息正文、播放器和业务权威状态不改变；数据库与生成竞速链路不进入本任务。

## 2. 请求链路

React Query queryFn 接收 `signal`，传给 `apiClient`/`timedFetch`。API Client 用同一 signal 同时控制排队、退避和 fetch；QueryClient 默认不重试，API Client 只对幂等 GET 的 timeout/TypeError 做最多一次退避重试。POST、HTTP 业务错误与主动 abort 均不重试。

`/api/lobby-characters` 的 Next route 将入站 `request.signal` 与固定上游 timeout 组合后传给 Railway fetch。浏览器离页或 5 秒预算耗尽时上游请求中止；响应契约和 no-store 不变。

## 3. 页面拆分

### `/characters`

- CharacterGallery 保持唯一的会话列表订阅，计算 experienced IDs 和 recent session。
- RecentConversationCard 变为展示组件，接收 recent session、父列表中的 character summary、loading/error/retry；不再调用会话或角色 query。
- 移除 effect 创建的 preload/preconnect，保留首屏 `<img>` 的 eager/high 策略。
- CharacterDetailSheet 使用 dynamic import，并只在 `previewId` 存在时挂载。

### `/chat/[characterId]`

- CharacterDetailSheet 与 ChatSessionDrawer 动态加载且只在打开时挂载。
- 关键 ChatTopBar、ChatMessageList、ChatComposer、ChatSplash 仍同步加载。
- 第一轮构建后若 route 独占仍高于 90 kB，再把图片/语音 footer 合并为一个按 session ready 后加载的 chunk；不拆正文 renderer 和 composer。

### `/`

- 新建轻量 comments context/owner；完整 DramaCommentSheet 保留在原业务模块并通过 dynamic import 仅在第一次打开评论时加载。
- DramaPlayer、playback query、video element、手势和进度条不懒加载，避免首帧回退。

## 4. Support unread

客户端把 `refetchOnMount: 'always'` 改为按 stale 判定，保留 20 秒可见轮询与前台恢复；queryFn 传 signal。

后端 support route 用既有 `requestLogger` 记录：`operation`、`status`、`identityMs`、`upstreamMs`、`totalMs`。错误日志使用 `{ err }`，operation 是固定低基数字段。不上报 user UUID、Telegram ID、消息正文、图片、secret 或完整 path。

若本地/发布后 `upstreamMs` 主导，则在验收记录中创建独立 `ST_cs_platform` 后续建议；本仓库不通过结果缓存伪造 p95 改善。

## 5. 可靠性设计

| 维度     | 设计                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| 超时     | lobby 上游 5s；现有 API Client 与 CS service timeout 保留；不延长用户等待             |
| 重试     | 幂等 GET 仅 API Client 最多一次；POST 0 次；abort 0 次                                |
| 幂等     | 所有写接口不改；support read/send、conversation send/regenerate 不新增重试            |
| 并发     | 复用 request-concurrency；取消释放排队和在途读；不新增全局队列                        |
| 事务     | 无新事务；不触碰 conversation CAS/计费 RPC                                            |
| 降级     | dynamic chunk 失败由现有 Next 错误边界/重新打开处理；关键正文与播放器不依赖可选 chunk |
| 补偿     | 无新写入，无需补偿；已有 generation reconciliation 不变                               |
| 限流     | 不新增请求；减少重复读。CS upstream 仍执行其自身限流                                  |
| 容量     | 不新增无界 cache/map；删除重复 observer 和 preload                                    |
| 可观测性 | build route size、UI 请求计数、support 阶段耗时；字段低基数且脱敏                     |

## 6. 演进与恢复

- 变更均兼容现有 HTTP/shared contract，无迁移与发布顺序依赖。
- 分批落地：请求取消/重试 → characters → chat → drama optional UI → support。
- 每批均可通过回退对应 dynamic import、query signal 或 mount 策略恢复，不影响已写业务数据。
- 停止条件：相关 UI 流程失败、route 首载增加、GET 尝试超过 2 次、abort 后继续发请求、support 未读出现明显陈旧或 first-token/计费测试回退。
- 生产 p95 恶化超过 5% 时回退对应页面批次；provider/DB 不随页面批次改动。

## 7. 最小充分性

新增文件仅允许一个轻量 drama comments context（若现有文件无法形成独立 chunk）和任务记录；不新增公开 API、contract、依赖、数据库状态源或通用性能框架。Chat media 的第二轮拆分由 90 kB 构建门禁触发，不预先实施。
