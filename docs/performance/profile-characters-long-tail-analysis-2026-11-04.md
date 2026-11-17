# `/characters` 与 `/profile` 性能长尾分析及优化方案

> 生成日期：2026-11-04（Asia/Shanghai）  
> 数据范围：Sentry 最近 7 天滚动窗口；Grafana 最近一次可读取窗口为 2026-10-27 18:00 至 2026-11-03 18:00  
> 适用平台：Android、iOS  
> 目标：点击跳转后，页面关键内容显示时间 P95 ≤ 2 秒

## 1. 结论

两个页面都同时存在真实加载问题和统计口径问题，但主因不同：

| 页面          | 主要判断                                         | 真实加载问题                                                                                         | 统计问题                                                                                                                             |
| ------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/profile`    | **统计口径放大为主，真实请求并发为辅**           | 进入页面同时发起钱包、设置、签到、VIP、套餐、邀请、社区、未读等请求，弱网下产生排队和连接复用竞争    | 线上版本曾把页面 ready 绑定到钱包结果；Sentry navigation 又会等待空闲窗口，容易把非首屏请求和用户后续操作计入页面时长                |
| `/characters` | **真实加载长尾为主，ready 定义不完整或过宽为辅** | 目录请求、路由 chunk、图片、角色社交数据和主线程长帧共同形成长尾；弱网样本中客户端耗时显著高于服务端 | 当前 ready 不等待首张关键图片，可能低估视觉可见时间；保留“推荐”排序的用户又可能被推荐批次阻塞，最高接近 5 秒，可能高估基础内容 ready |

因此，不能直接把 Sentry transaction P95 当作“页面可见 P95”，也不能只改上报口径后宣布性能达标。建议同时推进：

1. 先统一 `shell_ready`、`content_ready`、`critical_visual` 三段口径；
2. `/profile` 解除非首屏数据对 ready 的阻塞并削减首屏请求扇出；
3. `/characters` 保证公共/缓存卡片先可见，推荐刷新和社交信息后置，并继续压缩首屏资源与主线程工作；
4. 按 release、平台、导航类型和数据来源分别验证，避免不同版本混算。

### 1.1 本地实施状态（2026-11-04）

本报告对应的低风险二阶段优化已在当前工作区实现，但尚未发布，不能据此宣称生产 P95 已达标：

- `/characters`：会话史、角色社交批量和最新角标等待当前路由首张关键图结算；图片兜底记录 `critical_visual=timeout`；自动推荐读取 1.5 秒后沿现有内容降级，手动换批/撤回仍保留 5 秒。
- `/profile`：首帧只立即读取钱包；签到、VIP、套餐在首帧后启动；头像设置按打开菜单读取；邀请和社区接近服务区时启动；页面内消息/客服红点只观察 BottomNav 共享缓存。
- 本地验证：Frontend typecheck、69 个测试文件/768 项测试、lint、build 通过；Android 定向角色大厅 2 项、Profile 3 项与 320px 定向 3 项通过。
- 发布后仍需按新 release、Android/iOS、SPA/pageload、cache/fetch 重新观测，并联合检查 ready、stall、error 与 page_left。

## 2. 数据证据

### 2.1 Sentry 页面 transaction

最近 7 天，主要样本来自 SPA navigation：

| 页面          | 平台    | 样本数 |      P50 |      P95 |       P99 | 超过 2 秒 |
| ------------- | ------- | -----: | -------: | -------: | --------: | --------: |
| `/characters` | Android |  1,650 | 1,788 ms | 6,500 ms | 11,239 ms |    46.36% |
| `/characters` | iOS     |    420 | 1,481 ms | 6,034 ms | 12,453 ms |    41.67% |
| `/profile`    | Android |  1,125 | 1,318 ms | 6,372 ms |  8,580 ms |    38.22% |
| `/profile`    | iOS     |    255 | 1,110 ms | 4,663 ms |  7,925 ms |    29.41% |

冷启动 pageload 样本少，但明显更慢：`/profile` Android P95 约 14.2 秒，`/characters` Android P95 约 8.5 秒，`/profile` iOS P95 约 8.3 秒。冷启动需要单独治理，但它不是近 7 天长尾的唯一来源，因为主样本中的 SPA navigation 仍有 4.7 至 6.5 秒 P95。

### 2.2 Grafana 自定义页面指标

最近一次可读取的 7 天窗口：

| 页面          | 平台    | 样本数 | 页面跳转到 `content ready` P95 |
| ------------- | ------- | -----: | -----------------------------: |
| `/characters` | Android |    808 |                       4,036 ms |
| `/characters` | iOS     |    162 |                       2,320 ms |
| `/profile`    | Android |    656 |                       4,717 ms |
| `/profile`    | iOS     |    147 |                       2,691 ms |

Grafana 数值普遍低于 Sentry，是预期现象：

- Grafana `page.navigation` 从点击/导航开始，到页面显式调用 ready 结束，只记录前台成功的 SPA 导航；
- Sentry BrowserTracing transaction 按 idle 语义结束，可能覆盖非关键异步请求、长任务以及页面显示后的用户行为；
- Grafana 成功 ready 分布本身存在幸存者偏差，必须同时观察 `stalled`、`failed`、`page_left` 和样本数。

### 2.3 API 与链路证据

Grafana 同窗口中：

| API 分组                    | 平台    | 样本数 |      P95 |
| --------------------------- | ------- | -----: | -------: |
| wallet                      | Android |  2,851 | 3,704 ms |
| wallet                      | iOS     |    599 | 2,966 ms |
| other（含大厅角色、收藏等） | Android |  3,790 | 2,768 ms |
| other（含大厅角色、收藏等） | iOS     |    669 | 2,166 ms |

线上代表性 Sentry trace 显示：

- `/profile` Android 中，钱包客户端 2,857 ms、服务端 181 ms；设置客户端 2,424 ms、服务端 525 ms；未读、套餐、签到、邀请、VIP、社区和客服未读同时发出；
- `/profile` iOS 中，设置客户端 3,066 ms、钱包 2,948 ms，并出现重复签到读取及页面 transaction 内的签到写入；
- `/characters` Android 中出现 59 个 HTTP client span 和 8 个长动画帧，长帧 P95 约 1,110 ms；大量请求的客户端耗时在 0.5 至 1.7 秒，而服务端常见为 90 至 140 ms；
- `/characters` iOS 中两个 GET 接近 9 秒，角色图片资源约 1.9 秒，同时存在收藏、会话、社交信息等请求。

这说明服务端数据库并不是当前唯一或首要瓶颈。客户端网络建立、请求排队、资源下载、路由代码加载和主线程竞争占据了较大比例。Sentry 汇总中 connect/TLS、Next.js 页面 chunk、Supabase 图片和长动画帧也都存在秒级 P95。

代表 trace：

- [`/characters` Android](https://wangqiao.sentry.io/explore/traces/trace/28da123c3438428c92b6c90af66d6dda)
- [`/characters` iOS](https://wangqiao.sentry.io/explore/traces/trace/bcfbfa96783b47568f0483071e5c0e7c)
- [`/profile` Android](https://wangqiao.sentry.io/explore/traces/trace/7c9105f686b4413e848646e1bbd58a16)
- [`/profile` iOS](https://wangqiao.sentry.io/explore/traces/trace/72d62da5f2df45d195472c9965c3eb2a)

## 3. 根因分析

### 3.1 `/profile`：口径放大与请求扇出叠加

#### 统计口径问题

近 7 天生产数据的主版本为 `5fffd6ce1dcd0b23504f0e9699bde93ee0eb23ae`。该版本将页面 ready 绑定到钱包查询，钱包弱网 P95 会直接传导到页面 P95。Android 上页面 Grafana P95 4.72 秒、钱包 API P95 3.70 秒，两者高度接近。

同时，Sentry navigation 不是业务定义的“首屏可见时间”。只要 transaction 仍有异步 span 或未达到 idle，钱包之外的设置、签到、VIP、套餐、邀请、社区、未读等请求，甚至页面显示后的签到操作，都可能延长 transaction。因此 Sentry 4.7 至 6.4 秒的 P95 不能直接判定为用户一直看到空白页。

当前分支已经把 `/profile` 的 shell ready 与钱包 fresh 拆开：页面结构提交即可 ready，钱包新鲜度单独记录。方向正确，但近 7 天生产数据不包含当前 HEAD `62f45bea` 的完整效果，必须发布后按新 release 验证。

#### 真实加载问题

口径问题不代表没有真实性能问题。进入 `/profile` 时仍会同时挂载多项查询：钱包、消息未读、客服未读、用户设置、签到、VIP、支付套餐、邀请入口和社区入口。弱网或移动 WebView 下，这些请求会竞争连接、并发槽和主线程回调；即使 shell 已显示，金额、会员状态和签到等功能区仍可能长时间处于加载态。

结论：`/profile` 的“页面长尾”主要被统计放大，但“数据可用长尾”真实存在。

### 3.2 `/characters`：真实资源和主线程长尾更明显

#### 真实加载问题

代表 trace 中存在明显的请求扇出、图片资源下载和长动画帧，且客户端耗时远高于服务端耗时。大厅数据库查询本身通常只有几十毫秒，长尾更多发生在：

- Next.js 路由 chunk 尚未命中缓存；
- 移动网络 DNS/connect/TLS 和跨域连接成本；
- 角色目录与用户态扩展信息并发；
- 首屏图片下载、解码和渐显；
- 大量卡片或请求回调造成主线程长帧。

当前代码已包含一批针对这些问题的改动：移动端首批只渲染 4 张卡片、只有首张图片高优先级、角色图使用 360×480/quality 68 变体、社交数据在关键内容后按最多 40 个一批请求、localStorage 持久化延后到 idle、目录后台刷新延后。这些改动尚未由对应生产 release 数据证明，发布后应逐项观察。

#### 统计口径问题

当前 `/characters` 的 `content ready` 等待目录数据和 `recommendation.ready`，但不等待首张关键图片：

- 当目录很快但首图很慢时，指标会低估用户真正看到角色卡图片的时间；
- 当返回用户保留“推荐”排序且推荐批次过期时，推荐请求最长 5 秒会阻塞 ready，即使公共目录或旧批次已经可以稳定显示，指标会高估基础页面 ready。

因此，不能继续用一个 ready 同时表达“页面壳已渲染”“角色卡数据已出现”“首张卡图已显示”和“推荐结果已刷新”。

## 4. 统一上报方案

### 4.1 三段 ready

建议为两个页面统一记录：

| 指标              | 起点               | 终点                                 | 用途                               |
| ----------------- | ------------------ | ------------------------------------ | ---------------------------------- |
| `shell_ready`     | 点击或路由导航开始 | 标题、导航、主要操作区完成 commit    | 判断路由和 React 渲染是否及时响应  |
| `content_ready`   | 同上               | 可交互的真实关键数据完成 commit      | 作为“页面内容显示 ≤ 2 秒”的主 SLA  |
| `critical_visual` | 同上               | 首个关键图片加载成功、失败或确认无图 | 判断用户真正看到关键视觉内容的时间 |

补充记录 `fresh_data`，但不纳入页面 ready：

- `/profile`：钱包、VIP、签到等各自的数据新鲜时间；
- `/characters`：目录刷新、推荐批次刷新、社交数据完成时间。

Sentry BrowserTracing 保留用于查因，不再作为页面 SLA 的唯一数据源。

### 4.2 低基数维度

每条页面指标建议携带：

- `route`：仅固定路由；
- `platform`：`android` / `ios` / `other`；
- `release`；
- `navigation_type`：`spa` / `pageload`；
- `content_source`：`memory_cache` / `persisted_cache` / `network`；
- `/characters` 的 `sort`：`latest` / `recommended`；
- `ready_definition`：例如 `v2`，避免新旧口径混算。

不要上报角色 ID、用户 ID、完整 URL 或其他高基数/敏感字段。

### 4.3 必须成组观察的指标

每个 P95 面板同时展示：

- 成功 ready 样本数；
- `ready`、`stalled`、`failed`、`page_left` 的比例；
- P50/P75/P95/P99；
- Android/iOS 分组；
- SPA/pageload 分组；
- 当前 release 与前一 release 对比。

## 5. 优化实施方案

### 阶段 P0：先修正可验证性

预计改动风险低，建议最先发布。

1. 实现三段 ready，并为口径加版本号；
2. `/profile` 保持 shell ready 不依赖钱包，同时新增钱包/签到/VIP 的独立 data-ready；
3. `/characters` 单独记录 `catalog_ready`、`recommendation_ready`、`first_card_commit`、`critical_visual`；
4. Grafana 将成功时长与 stalled/failed/page_left 放在同一看板；
5. 查询固定同一时间窗口和同一 release，禁止把 Sentry 滚动窗口与 Grafana旧窗口直接做数值回归比较。

### 阶段 P1：`/profile` 首屏减负

1. **首屏分级**：钱包和页面基本身份信息为 P0；签到/VIP 为 P1；套餐、邀请、社区、消息徽标等按实际可见区域和交互需要降为 P2；
2. **稳定占位与缓存复用**：页面先显示可操作结构，缓存数据允许立即展示并标记刷新，不让非关键请求阻塞 content ready；
3. **延后非首屏查询**：在 shell/content ready 后、浏览器空闲时或区域接近 viewport 时再请求套餐、邀请、社区等数据；
4. **避免重复消费者**：核对 BottomNav 与 Profile 页面共享的未读 query key，确保 React Query 实际去重，不产生重复网络请求；
5. **保留关键并发配额**：钱包使用 critical 槽位，非关键查询使用 normal/background，避免它们抢占入场请求；
6. **第二阶段再评估聚合接口**：只有发布后仍证明连接与请求头成本占主导，才考虑将稳定、同屏、同权限的读接口合并为 profile overview。不要一开始就引入新的聚合层。

### 阶段 P1：`/characters` 关键内容优先

1. **最新排序保持默认**：新用户直接请求公共 `latest` 目录，不让个性化推荐阻塞首次可见；
2. **推荐刷新不阻塞基础内容**：返回用户选择推荐时，优先稳定展示可用的旧推荐批次或公共目录；推荐刷新单独记录。不能在新结果到达后突然重排当前视口；
3. **目录是唯一 P0 请求**：收藏、会话、社交计数、最新角标等均在关键卡片 commit/visual 后启动；
4. **继续保持移动端预算**：首批 4 张、首张高优先图片，其余卡片按滚动批次追加；
5. **公共目录缓存**：评估对 `latest`/`popular` 使用 ETag 或短时 `stale-while-revalidate`，按 sort 缓存；个性化推荐禁止混入公共缓存；
6. **图片链路**：保持 360×480 变体与异步解码，按真实设备 DPR/容器宽度核对是否还可降低字节数；只对首张图使用 high priority；
7. **主线程治理**：持续观察 long animation frame，避免卡片首屏 effects、localStorage 序列化和批量 cache 写入与导航 commit 同帧发生。

### 阶段 P2：网络和冷启动

1. 分开统计 pageload；核对路由 chunk 未命中时的下载、解析和执行时间；
2. 仅对真实证据中的关键 origin 做 preconnect，避免无差别连接；
3. 评估关键 Profile API 使用同源代理或稳定 HTTP/2/HTTP/3 复用的收益，但要先确认认证、缓存和容量边界；
4. 服务端只优化实际占比高的 handler。当前 trace 中多数 handler 明显快于客户端总耗时，不应先做无证据的数据库重构。

## 6. Android 与 iOS 的侧重点

### Android

- 两个页面 P95 都显著更高，优先控制并发、主线程长帧和首批渲染量；
- 维持更小的 render batch，并在低端 Android WebView 真机验证；
- 重点看客户端请求排队、长动画帧和 JS chunk 执行，而不只看服务端耗时。

### iOS

- 中位数较好，但 `/characters` P99 更高，重点关注极弱网、图片连接和偶发超慢 GET；
- 保持图片资源预算和推荐超时降级；
- 验证 Safari/WebView 的 bfcache、页面恢复和 visibility 变化不会产生重复导航样本。

## 7. 验收标准与发布策略

### 指标验收

按 route × platform × release，且单组样本数建议不少于 100：

- `content_ready` P95 ≤ 2,000 ms；
- `shell_ready` 作为更严格的前置指标，建议 P95 ≤ 1,000 ms；
- `critical_visual` 单独观察，目标与产品对“内容显示”的定义对齐后确定；
- stalled/failed/page_left 不得因缩短 ready 口径而恶化；
- API 请求量、错误率和后端容量不得出现不可接受增长。

### 灰度与停止条件

1. 按 10% → 50% → 100% 或按可用发布机制逐步放量；
2. 每阶段至少覆盖 Android/iOS 的有效样本；
3. 如果页面失败/离开比例上升、API 请求量显著增长、主接口 P95 回退，停止放量；
4. 回滚可关闭预取、延迟刷新或推荐非阻塞策略，但 ready 定义变更必须通过 `ready_definition` 版本区分，不能静默改回后与历史数据混算。

## 8. 推荐执行顺序

1. 先完成指标口径和 Grafana 看板调整；
2. 发布当前分支已有的 Profile shell-ready、Characters 首批渲染/图片/社交批量优化；
3. 用新 release 连续观察至少 24 小时，并确保各平台样本充足；
4. 根据分段指标定位剩余瓶颈：
   - shell 慢：路由 chunk、React commit、主线程；
   - content 慢：关键 API、缓存未命中；
   - visual 慢：图片网络、解码和渲染；
   - Sentry 慢但三段 ready 正常：非首屏请求扇出或 transaction idle 口径；
5. 再决定是否需要公共目录边缘缓存、Profile 聚合接口或同源网络改造。

## 9. 当前限制

- Grafana 本轮连接凭证已过期，本报告使用最近一次成功读取的固定窗口；恢复连接后必须用与 Sentry 完全一致的窗口重跑；
- 近 7 天数据包含 88 个 release 分组，聚合值受版本混合影响；主 release 单独查看后仍存在长尾，因此版本混合不是唯一原因；
- 当前本地 HEAD 的多项优化尚无对应生产样本，文中均按“待验证”处理；
- 仅凭现有样本不能可靠给出“加载问题占多少百分比、统计问题占多少百分比”，不应编造因果比例。
