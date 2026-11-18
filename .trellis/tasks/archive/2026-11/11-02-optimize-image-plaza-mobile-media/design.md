# 技术设计

## 1. 边界与数据流

本任务只改 Frontend：

```text
tg_platform -> mobile-performance policy
             -> /create render limit + responsive preview + critical visual
             -> Studio responsive image + near-viewport video activation

React Query cache -> existing image-plaza API hooks -> existing DTO -> UI
```

不修改 shared contract、Backend route/repository、数据库或生成任务。图片转换只复用 `supabasePublicImageUrl/srcSet`；非 Supabase URL 及转换失败回退原 URL。

## 2. 复用调研

| 已检索能力                                        | 决策       | 理由                                                                   |
| ------------------------------------------------- | ---------- | ---------------------------------------------------------------------- |
| `lib/mobile-performance.ts`                       | 扩展       | 已负责 Android/iOS 有界列表预算，避免第二套平台判断。                  |
| `CharacterGallery`、`/dramas` 渐进挂载            | 复用模式   | IntersectionObserver、无观察器兜底、首图 high 已在线使用。             |
| `lib/supabase-image.ts`                           | 直接复用   | 有限规格、外链不改写，符合缓存键和兼容要求。                           |
| `markPageCriticalVisual`、`usePageReady`          | 直接复用   | 保持数据 ready 与真实视觉 ready 分离。                                 |
| `canPrefetchInBackground`、`afterEntryBackground` | 直接复用   | 已包含前台、在线、省流和弱网门禁。                                     |
| `prefetchImagePlazaFeed/config`                   | 直接复用   | React Query 同 key 去重，失败静默，避免自建缓存。                      |
| `image-plaza-return.ts`                           | 保留并适配 | 返回快照是现有功能；有快照时保持当前已缓存项目全量挂载以避免锚点丢失。 |
| Studio conversation/API                           | 不改       | 历史截断或分页会改变合同和交互，本轮证据不足且风险高。                 |
| 虚拟列表/全局媒体调度器                           | 不采用     | 新依赖和状态源过重，当前渐进挂载与近视口激活已足够。                   |

## 3. 分平台资源预算

- Android：广场首批 6、批次 6、较近的补齐边界；视频只在较近视口时激活，优先降低 WebView DOM、解码和 Range 请求竞争。
- iOS：首批 6、批次 8、适度提前补齐；保持滚动连续性，同时限制首屏并发。
- unknown/desktop：保守首批 8、批次 8，网络和观察器不可用时安全退回现有行为。
- 所有平台只有第一张图 `high`，前两张 `eager`；Feed 与 Studio 使用固定少量响应式宽度，避免制造无界 CDN cache key。

具体数值只属于资源调度候选，production 按 release、平台和样本门槛复核；本地完成不等于线上达标。

## 4. `/create` 方案

1. 首次冷进入仅渲染平台预算项目；同一 sentinel 优先增加本地 render limit，全部已有项目挂载后才调用 `fetchNextPage`，避免尚未展示第一页就连续拉取后页。
2. 搜索/筛选/排序变化重置预算；有 return snapshot 时保持当前缓存项目全量挂载，先保证原锚点恢复和已浏览内容完整。
3. 首两项构成关键视觉集合；load/error/absent 全部结算后上报一次。图片转换失败先回退原 URL，原 URL 再失败才记 error 并显示稳定占位。
4. 标签计数和模型配置在关键视觉结算后启动；最多 1.5 秒兜底，防止资源永远不结算导致功能旁路饥饿。用户点击创作仍立即走既有 config prefetch。

## 5. Studio 方案

1. 图片展示加载有限 transformation/srcset，下载、原图、分享、封面和参考仍使用原 artifact URL；转换失败回退原图。
2. 视频卡初始为 poster + 显式播放按钮；进入视口附近或用户点击后才挂 `<video src>`。激活是单向的，不因滚动卸载，避免打断播放或丢失进度。
3. 保留原生 controls、playsInline、metadata preload 和所有操作按钮；不自动播放。
4. 初始会话若有最新 ready 媒体，以其首个 artifact/poster 结算 critical visual；空会话、生成中或没有 ready 媒体记 absent，不能等待完整生成。
5. 现有 `image.display.duration` 继续仅在最新一次新生成图片 onLoad 时结算，不与页面 critical visual 混用。

## 6. 可靠性设计

| 项目      | 设计                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------- |
| 超时      | 不新增网络超时；关键视觉有 1.5 秒旁路启动兜底，但指标仍等待真实 load/error/absent。                |
| 有限重试  | 不新增自动重试；转换图仅回退一次原 URL，API 和用户重试沿用现状。                                   |
| 幂等      | critical visual tracker 和媒体结算回调只消费首个终态；视频激活 `false -> true` 单向。              |
| 并发      | 首批 DOM、high 图片和视频 src 均有界；后台预取受统一门禁，React Query 同 key 去重。                |
| 事务      | 纯展示/缓存预热，无数据库事务或业务写入。                                                          |
| 降级      | 无 IntersectionObserver 时渲染已有 Feed 全量并按原逻辑翻页；外链不转换；无 poster 仍提供播放按钮。 |
| 补偿      | 无写入，无补偿；预取失败由页面 query 正常请求。                                                    |
| 限流/容量 | 不增加接口页大小；不缓存 blob；不把视频 fetch 到内存。                                             |
| 可观测性  | page.ready、critical visual、视频 metadata/首帧和完整生成分开；production 按平台/release 验证。    |

## 7. 最小充分方案

- 只扩展现有 policy 和现有页面/卡片，不新增 provider、store、依赖或公开 API。
- 不做对话历史分页、全局媒体互斥、设备能力评分、Service Worker 或通用虚拟列表框架。
- 不改业务 UI 结构；仅增加视频未激活时明确的 poster/播放按钮和图片错误占位。

## 8. 演进、发布与恢复

- 兼容：DTO、query key、路由、操作回调和原始媒体 URL 均不变。
- 发布顺序：单次 Frontend 发布；无需 Backend/migration。按 release 分割新旧口径。
- 停止条件：任一平台出现返回锚点丢失、列表断档、翻页重复、原图/分享失败、视频无法播放/下载或错误率明显上升，停止扩量。
- 回滚：恢复固定全量挂载、原图片 src 和 video 直接 src；删除新增 policy 字段/关键视觉接线即可，无数据回滚。
- forward-fix：若页面 critical visual 达标但 API、metadata 或首帧仍慢，再以对应分段证据优化 CDN/编码/服务端，不用本轮指标替代。

## 9. 可验证性

- 成功路径：广场首屏、渐进补齐、详情/用同款、图片生成、视频生成并播放、返回恢复。
- 失败路径：Feed 失败重试、转换图片回退/原图失败占位、图片生成失败、视频无 poster 后手动播放、预取被门禁拒绝。
- consumer：React Query cache、return snapshot、Studio 各操作仍消费同一 DTO/URL。
- 人工场景：Android/iOS Telegram 冷进入 `/creation -> /create`、深历史 Studio 返回、滚动播放多个视频、Save-Data/2G、后台恢复。
