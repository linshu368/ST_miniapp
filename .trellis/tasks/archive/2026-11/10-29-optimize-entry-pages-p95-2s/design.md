# 技术设计：三处入口 p95 两秒性能优化

## 1. 证据与诊断

详细数值见 `research/baseline.md`。结论如下：

1. Sentry 固定基线中三页均明显高于 2 秒；后续已落地请求去重、取消与非关键 UI 懒加载，但不能重复把这些列为新收益。
2. 当前 Grafana 24 小时数据显示 `/characters` SPA p95 约 2.13 秒、`/dramas` SPA p95 约 0.60 秒，而首页 document p95 约 5.71 秒；但 `page_fresh` 仍约 2.32–4.92 秒。
3. Railway 24 小时 `/api/dramas`、`/api/characters` 最慢小时 p95 分别约 1.08 秒和 0.94 秒；CPU 峰值约 0.112 核、内存峰值约 0.488 GB，远低于限制。扩容不是主解。
4. drama 客户端 API stage p95 中 headers 约 3.45 秒，显著高于 Railway handler；需要从网络、边缘、鉴权、重试与媒体瀑布排查，不能把全部时间归因于数据库。
5. `/characters` 已使用 Supabase transformed public avatar；`/dramas` 仍请求原始封面；首页视频生产仍使用 Supabase signed URL，Bunny 仅在 TEST PR 525 受门禁启用。

### 1.1 Grafana p95 驱动的优化优先级

| 证据                                                            |                     差距 | 优化方向                                                 | 对应阶段 |
| --------------------------------------------------------------- | -----------------------: | -------------------------------------------------------- | -------- |
| 首页 document `page_ready` 5713.5ms；`first_visual` 约 5146.8ms |        距 2s 约 3.1–3.7s | 目录缓存先显示、主海报变体、视频 CDN 真机验证            | B、C、D  |
| 角色卡 SPA `page_ready` 2126.5ms                                |         距 2s 约 126.5ms | 避免 freshness 与首屏头像争网；验证 BFF 额外跳转         | B        |
| 角色卡 `page_fresh` 4795.2ms                                    |          距 2.5s 约 2.3s | 延后/合并后台刷新，缩短服务链路长尾                      | B        |
| 短剧广场 SPA `page_ready` 605.0ms                               |               已在 2s 内 | 以不退化为先，重点补冷缓存和关键封面真实可见指标         | A、B、C  |
| 短剧 `page_fresh` 2324.9ms                                      |              已接近 2.5s | 保持稳定，避免为首页缓存增加重复刷新                     | B        |
| drama `st_api_total` 4496.5ms；headers 3446.0ms                 | 距 2s/1.5s 约 2.5s/1.95s | 重点排查客户端到响应头，不先优化 65.1ms queue 或盲目扩容 | A、B     |

优化排序由“离目标差距 × 用户入口频率 × 可控性”决定：先首页冷启动，再角色 freshness/链路，短剧广场以图片字节和冷路径为主。完整数值门禁见 PRD 4.2。

## 2. 复用调研

### 2.1 复用

- 复用 `usePageReady`、现有工程性能事件和首页 `drama.first_visual/first_frame`，只补三页共同缺少的“关键视觉已收敛”口径。
- 复用角色列表 localStorage 版本化缓存的思路，为短剧目录提供专用、有限、可校验缓存；不抽象成通用持久化框架。
- 复用 `CharacterCard` 的 Supabase `/storage/v1/render/image/public` 做法，收敛为有限图片规格。
- 复用 `entry-phase` 的关键/丰富阶段，让后台刷新和非关键预取不抢首屏网络。
- 复用现有 Bunny 签名、单飞、Range 校验和回滚开关；生产化只补环境化门禁与灰度，不另造代理层。
- 复用 `packages/ui-tests` 的 `@drama`、`@roleplay` fixture 和固定端口。

### 2.2 扩展

- drama list hook 增加专用版本化目录缓存、`initialDataUpdatedAt` 和后台校准。
- drama cover 增加 Supabase public transform URL helper 和有限 `srcset` 规格。
- character 背景刷新延后到关键头像收敛后，或采用短 stale window；保持显式操作后的失效能力。
- Bunny 配置从硬编码 TEST PR 525 扩展为显式 provider/environment/origin/namespace allowlist，生产 secrets 与 TEST 分离。

### 2.3 不复用/不新增

- 不新增 Redis/CDN 网关、Service Worker、图片代理服务、数据库缓存表或跨应用状态总线。
- 不用 Next Image 默认代理替代 Supabase CDN，以免增加一次源站跳转；仅在构建实测证明更优时调整。
- 不把公共图片加入当前 Bunny 私有视频 zone；图片优先使用 Supabase Smart CDN 和 Image Transformations。
- 不拆分播放器关键 chunk；只有 bundle 分析证明非关键模块 >10 KB 且主线程 p95 明显时，才拆 `/dramas` 非默认 tab。

## 3. 方案

### 3.1 阶段 A：先修测量口径

- `/` 继续使用现有 first visual/first frame；把 sample outcome 明确为 `success|error|absent|timeout`。
- `/characters` 以首个可见角色卡可操作且关键头像 settled 为关键视觉。
- `/dramas` 以第一行可操作且前两张封面 settled 为关键视觉。
- 保留 `page.ready`（数据/组件就绪）和 `page.fresh`（后台校准完成），新增指标不改旧 dashboard 历史序列。
- 从 Performance Resource Timing 采集阶段耗时和 transfer size；URL 只分类为 `supabase_image|supabase_video|bunny_video|other`，不发送路径或查询参数。
- 固化 Grafana 查询：production 环境、单一 release、route、document/SPA、cold/warm、provider/cache class；dashboard 同时展示 p50/p95、样本量和各终态计数。
- `page_ready` 与新增关键视觉事件并行保留至少一个完整发布窗口；只有二者语义和采样稳定后，关键视觉才成为主要发布门禁。

只有建立新口径并收集基线后，才进入行为优化，避免“改定义即达标”。

### 3.2 阶段 B：目录缓存与调度

#### 首页与短剧广场

- 为非敏感 drama catalog summary 建立版本化、有限大小的本地缓存；仅保存列表展示和选片必需字段，不保存 signed playback URL。
- 缓存命中立即作为 React Query `initialData`；按保存时间设置 `initialDataUpdatedAt`，在后台重新校准。
- 缓存版本不匹配、解析失败、超过 TTL 或条目超限时丢弃；写入安排在空闲阶段。
- 首页 remembered drama 不再存在时，在 fresh response 到达后安全切换；刷新失败时继续展示缓存并标记 stale，不无限重试。
- 冷缓存仍走现有 critical request；不为列表请求叠加更多 retry。

建议初始 TTL 15 分钟、最大条目数按生产目录上界加安全余量确定；通过配置常量而非新公开 API 调整。

#### 角色卡

- 保留现有 24 小时可用缓存作为离线/慢网兜底。
- 先做调度实验：首屏关键头像 settled 后再启动背景 freshness；若业务要求必须立即刷新，则使用 2–5 分钟短 stale window 避免 SPA 往返重复请求。
- 同源 Next BFF 与直连 Railway 做受控对比。仅当直连在 Telegram 真机 p95 至少改善 300ms，且 CORS、鉴权、错误口径稳定时才切换；否则保留 BFF。
- 推荐列表的随机/个性化语义保持 `no-store`；不得为追求 CDN 命中错误共享个性化响应。

### 3.3 阶段 C：图片/CDN

- 短剧广场封面改用 Supabase public image transformation：卡片基准 360×480、`cover`、quality 约 68；按实际 CSS 宽度提供少量固定变体和 `sizes`。
- 首页主海报使用约 720/1280 两档、quality 70–75；相邻预览保持更小规格、lazy/low priority。
- 角色头像沿用现有 360×480 q68，按真实首屏卡数校准 eager 数；不因为优化扩大高优先级图片数量。
- 用响应头 `cf-cache-status`、content-length、TTFB 和 decode 验证收益；固定变体数量以提高边缘命中。
- 后续上传采用 immutable/versioned object path 与合理 `cacheControl`；本任务不批量改写历史对象。内容替换时换版本路径，避免浏览器 TTL 和 CDN 失效窗口产生旧图。

### 3.4 阶段 D：首页视频 Bunny 灰度

1. 在 TEST/PR 525 以相同对象对比 Supabase 与 Bunny：至少每 provider 100 次真实 Telegram 移动端播放或最多 7 天。
2. 比较 first visual、first frame、playing、TTFB、Range HIT/MISS、卡顿、错误和 page-left；功能通过但性能无证据不能进入生产。
3. 将现有配置改为显式 `provider`、环境 allowlist、期望 Supabase origin、Bunny namespace；production 使用独立 namespace/rules/token。
4. 生产按 5%→25%→100% 逐级灰度，每级至少观察一个完整高峰窗口；分流必须稳定，单次播放不混用 provider。
5. 达到 PRD 停止条件立即关闭 flag。已有签名 URL 在有效期内继续播放，新请求恢复 Supabase；无需数据回滚。

不做无证据的自动 fallback：403/签名/Range 错误应清晰暴露并触发回滚，避免双请求扩大带宽和长尾。

### 3.5 阶段 E：条件式 bundle 优化

- 记录 route chunk、long task、JS parse/execute。仅当初始 JS 主线程 p95 >300ms 且存在 >10 KB 非关键模块时行动。
- 候选仅限 `/dramas` 非默认 library tab；默认 theater、首页播放器和首屏角色卡不得延迟加载。
- 已完成的角色详情/评论动态加载不重复修改。

## 4. 可靠性设计

| 维度      | 设计                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------- |
| 超时      | 沿用 API 5 秒边界；关键视觉有独立 settled/timeout，避免指标永不结束                                |
| 重试      | 仅安全 GET 最多一次；CDN 媒体不在前端自动双源重试                                                  |
| 幂等      | 目录读取和缓存写入幂等；不涉及业务写入                                                             |
| 并发      | React Query 去重、AbortSignal、现有 Bunny single-flight；背景刷新在关键媒体后启动                  |
| 事务      | 无跨资源写入，不适用                                                                               |
| 降级      | 缓存→网络、图片失败占位、视频通过 flag 回到 Supabase                                               |
| 补偿      | 无业务数据变更；错误缓存删除，CDN 配置回滚/必要时 purge                                            |
| 限流/容量 | 固定图片 variants、有限 catalog cache、Bunny 分阶段流量；监控 Supabase transform 配额与源站 egress |
| 可观测性  | release/cohort/provider/cache class 低基数字段；禁止 URL/token/个人数据                            |

## 5. 最小充分性

新状态源仅一个 drama catalog 本地缓存；新公开 API 为零；预计不新增依赖、不新增数据库对象。图片 helper 和性能 mark 优先放入现有领域文件或已有性能模块。任何直连 Railway、bundle 拆分和生产 Bunny 都由实测门禁触发，不作为默认必做改动。

## 6. 演进、发布与恢复

- 发布顺序：测量口径 → 目录缓存/调度 → 图片变体 → TEST Bunny 对比 → 生产灰度 → 条件式 bundle。
- 每批独立 commit/部署，不能把测量、缓存和 CDN 切换绑成一次发布。
- 每批在 Grafana 记录发布标记，先比较同 release 24 小时 p95，再看 7 天滚动 p95；禁止跨 release 混算后宣称改善。
- catalog cache 使用版本 key；回滚代码时旧 key 不被读取，新旧版本互不污染。
- 图片 URL 改动无需数据库迁移；回滚恢复原始 public URL。
- Bunny 以服务端开关控制；生产 secret/规则先配置但不开流量，回滚只关开关并保留日志证据。
- 停止条件遵循 PRD；未达到样本量不升级灰度。

## 7. 安全与契约

- 不缓存 playback signed URL 到持久存储。
- 不降低 `/api/dramas` 鉴权，不把用户相关响应设为 shared cache。
- CDN token、origin token 仅服务端环境变量；日志只记 provider/outcome/duration。
- 当前方案不改变外部 DTO；若实现中必须改 DTO，先更新 shared contract、消费者 typecheck 和本设计，重新评审。
