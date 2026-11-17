# Sentry 全链路性能优化技术设计

## 1. 设计结论

当前 Railway CPU、内存和 Supabase 连接均无饱和证据。优化主线是：前端请求调度与资源加载、戏剧首屏瀑布、图片 feed hydrate/签名，以及生成 server-ready 到 client-visible 的交付尾延迟。基础设施扩容和批量加索引不作为首选。

## 2. 范围与边界

覆盖 Frontend、Backend、Shared contracts、Supabase 只读计划与必要的手工 migration。Railway/Sentry/Supabase 远程写入、生产迁移和容量升级均不在默认授权内。

完整链路：`页面导航 -> React Query/API client -> Backend route -> feature/repository -> Supabase/Storage/provider -> response/SSE -> React commit/媒体首帧 -> Sentry/Pino`。

## 3. 复用调研

| 能力           | 现有位置                                            | 决策                                                            |
| -------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| 请求阶段       | `frontend/src/lib/entry-phase.ts`                   | 扩展为 startup + route epoch，不另建状态框架                    |
| 请求并发       | `frontend/src/lib/api/request-concurrency.ts`       | 扩展优先级、取消和关键槽位，不引入新调度依赖                    |
| HTTP 与重试    | `frontend/src/lib/api/client.ts`、`query-client.ts` | 收敛为单一总预算，继续复用统一 client                           |
| 戏剧播放       | `components/drama/*`、Backend drama routes/features | 并行化关键读取；只有实测仍不足才扩展聚合 DTO                    |
| 生成           | `backend/src/features/generation/`                  | 建立请求级 snapshot，继续使用既有 fallback、CAS、计费与终态路径 |
| runtime config | `platform/runtime-config.ts`                        | 先消除同请求重复读取；仅非计费展示配置允许短 SWR                |
| 图片广场       | 现有 image plaza route/repository/sign helper       | 显式投影、批量签名和有界 inflight cache，不开放私有 bucket      |
| 文本后处理     | 现有 immutable version service/repository           | 有界 LRU + inflight + miss 批读，不改变版本绑定语义             |
| 遥测           | Sentry、Pino、现有 drama timing                     | 增加阶段字段和有界异步队列，不引入通用 MQ                       |

不复用旧任务中的过期模块载荷或旧生产结论；生产 main 与当前环境必须重新比对。

## 4. 分阶段方案

### 4.1 P0：证据和前端调度

- 增加 route epoch；路由切换时取消旧 epoch 的排队请求与可取消读取。
- 所有 React Query queryFn 透传 `AbortSignal` 到统一 client。
- critical 预留至少一个请求槽；telemetry 使用独立 background 预算。
- GET 重试只保留一个控制层，总预算 3–5 秒，最多一次幂等重试。
- drama repository 保留原始错误 `cause`，route/global logger 继续使用 `{ err }`。
- Sentry 生成 span 拆为 preparation、TTFT、stream、client-visible、settle；full SSE 只按输出长度/tokens 分桶观察。

### 4.2 P0：戏剧首屏

- 先记录 `导航 -> 目录/详情/play -> 视频 metadata -> 首帧` 的完整瀑布，并拆分请求排队、Backend、Supabase、媒体连接/下载/解码和 React commit；分别验证冷/热缓存、弱网和 SPA 返回场景。
- 已有 activeId 时，play 请求与目录并行；play 为 critical。
- detail/social/相邻目录和评论在播放地址或首帧后加载。
- 播放器、评论和选集按路由拆分动态 chunk；首屏只预载必要 metadata 与首个可播放资源，不允许播放器依赖进入根布局或角色大厅 bundle。
- 控制卡片批量挂载、图片 priority 和视频 preload；离开短剧路由时取消可取消的目录、社交、play、封面预取和未开始媒体请求。
- telemetry 验证后立即 202，进入有界队列；过载时丢弃普通样本并计数，错误/慢请求/终态保留。
- 先根据保留的 Supabase error code 消除 5xx，再评估 30–60 秒 catalog SWR/ETag。
- 若并行化仍达不到目标，再设计最小首屏聚合响应；新 DTO 必须先进入 shared。

### 4.3 P1：非关键页面请求

- Characters 收藏/会话由父层单订阅并下传，避免每卡重复订阅。
- Profile 只把钱包与核心状态列为 P0，其余通知、社区、邀请按可见性分波。
- Chat 的模型面板、图片、语音、会话抽屉和工具按需动态加载。
- 长列表分批挂载或窗口化；首屏只保留 1–2 张高优先图片。

### 4.4 P1：图片广场和文本后处理

- 先拆分 `路由 chunk -> feed 配置/查询 -> hydrate -> 签名 -> 下载/解码 -> 首个可见内容`，明确 Backend 3.24 秒与 Supabase 边缘约 0.46 秒之间的耗时归属。
- 图片 feed 配置使用有界短 TTL/inflight cache；失败 promise 不入缓存。
- 查询改显式投影；逐图签名改为一次批量签名，缓存 TTL 必须短于真实 URL expiry。
- feed prefetch 仅在明确导航意图，或进入影像广场后满足网络/idle 门禁时执行；不得由根 Providers 或 `/characters` 在大厅稳定前触发。
- 编辑器、详情和生成工具按需动态加载；首个可见媒体使用高优先级，其余媒体懒加载和异步解码，并控制 DOM 数量；离开影像广场时取消分页、签名和未开始媒体请求。
- Text postprocess immutable version 使用有界 LRU；只批读 miss，失败不做长负缓存，数据库请求 2 秒超时。

### 4.4.1 大厅加载隔离与非回归

- `/characters` 与根 shell 只拥有大厅启动所需依赖，不导入短剧播放器、影像编辑器/生成器或它们的路由状态。
- route epoch 隔离并发；从短剧或影像广场返回大厅后，旧路由请求不得继续占用 critical 槽位，telemetry 使用独立有界队列。
- 共享组件仅复用无副作用的展示层；不得把预取、SDK 初始化、媒体探测或路由专属 query subscription 提升到根层。
- 发布门禁比较大厅请求数、传输字节、已执行 JS、长任务、React commit 和导航 P95；任一可归因于短剧/影像优化的生产回退超过 5% 即停止该批次。

### 4.5 P1/P2：生成链路

- 本节在 2026-10-29 整体复盘和用户再次确认前冻结：不得修改 first-token、fallback/竞速、provider 路由、客户端可见确认、计费资格、终态持久化、相关 migration 或 runtime config。
- 冻结期间只允许只读观察最新 first-token release，按 release 分窗积累满 24 小时的样本；不得以“补指标”为由改变现有 first-token 运行语义。
- 若复盘显示 client-visible P95 已稳定达标，停止侵入式改造；若未达标，也必须先取得用户明确授权才进入以下候选方案。
- 否则建立请求级 `GenerationConfigSnapshot`，批量读取并透传模型、展示、规则和计费所需事实。
- 展示类配置可短 SWR；价格、额度、计费和正式 postprocess snapshot 过期后 fail-closed。
- 保留 10 秒总 TTFT、现有 hedged fallback 和 loser cancel；不增加总 deadline 外串行重试。
- provider/model 断路器使用低基数滚动指标，只影响路由，不影响计费和数据库权威状态。
- execute 明确返回 persistence handled/pending；只消除成功流的重复终态读取，pre-stream error 仍由外层收口。

### 4.6 P2：数据库候选

- 对 stale streaming 恢复、会话列表、图片推荐/搜索分别取得 TEST 与 Production 计划。
- 只有 `EXPLAIN (ANALYZE, BUFFERS)` 证明收益时，才考虑部分覆盖索引、keyset、RPC/UNION 或 trigram/FTS。
- 后台长 analytics 查询独立设置 statement timeout、离峰执行或增量汇总，不与页面链路混为同一个 SLO。
- 不批量修复 advisor 的全部 FK 索引，不因 unused 标记立即删索引，不调整 pool size。

## 5. 可靠性设计

| 故障面    | 设计                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| 超时      | 前端 GET 统一总预算；DB/Storage 继承现有上限；首 token 总预算保持 10 秒               |
| 重试      | 仅幂等读取和首 token 前安全 fallback；有限、退避、尊重 Retry-After，不重置总 deadline |
| 幂等/并发 | generation/history/quota 继续以数据库 CAS/RPC 为权威；缓存和断路器不拥有业务状态      |
| 事务      | 不把外部 provider 放进数据库长事务；多表不变量继续由现有 RPC 保证                     |
| 降级      | telemetry/diagnosis/cache miss 不阻断主流程；计费和正式版本配置 fail-closed           |
| 补偿      | 继续复用 generation sync/reconciliation；本任务不增加第二套补偿器                     |
| 限流/容量 | 所有队列、LRU、single-flight 有 max entries、TTL、丢弃计数；多 replica 缓存不作为权威 |
| 可观测性  | 阶段耗时、cache status、provider/error category 使用低基数字段；禁止正文和 secret     |

## 6. 最小充分方案与拒绝项

- 不新增 Redux、通用 workflow、通用缓存框架或消息队列。
- 不先做 BFF；先并行化和优先级调度，实测不足再扩展最小聚合接口。
- 不先扩 Railway；资源未饱和，扩 replica 还会放大本地 cache 与 background job 协调问题。
- 不新建数据库表承载性能状态；优先使用现有指标、RPC 和 runtime config。
- 不用 public bucket 替代私有签名 URL，除非另行完成安全评审。
- 不为缩短二次进入时间而在全局启动阶段预载全部短剧/影像 chunk 或媒体；路由局部、可取消的按需加载是本任务的最小充分方案。

## 7. 演进、发布与恢复

按“观测 -> 调度 -> drama -> image/text -> generation -> DB”发布。每批通过 runtime config 或本地 feature flag 可关闭；比较同一 release 前后 2 小时和 24 小时窗口。

生成批次是独立门禁：2026-10-29 复盘前不能与观测、导航、drama、image/text 批次一起实施，也不能因其他批次获批而推断其已获授权。

停止条件：5xx 增加 0.2 个百分点、TTFT/导航 P95 恶化 10%、delivery failure 超过 0.5%、计费/额度不一致、队列持续丢弃或内存无界增长。前端调度可回退旧策略；cache 可全关；provider 策略可回退现有固定规则；索引仅以独立 `CONCURRENTLY` migration 手工执行并保留 drop-index 回滚说明。

新表/view/RPC 默认不假定 Data API 自动暴露；显式核对 schema/grant/RLS。数据库回滚不能破坏已写业务事实，无法安全回滚时采用 forward-fix。

## 8. 验证边界

自动验证不能替代 Telegram WebView、真实媒体首帧、真实 provider、真实计费和生产数据库计划。新增完整用户流程和失败恢复后，应扩展 `packages/ui-tests` 现有固定 fixture，而不是另建一次性 mock 服务。
