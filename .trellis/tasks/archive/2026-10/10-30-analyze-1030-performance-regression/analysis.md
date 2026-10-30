# 2026-10-30 性能下降部署链路分析

## 1. 结论摘要

30 日并不是所有页面和接口统一退化，而是两类问题叠加后形成了“整体明显变慢”的观感：

1. **页面导航尾延迟集中在 Telegram Android WebView。** `/characters`、`/profile`、`/create/studio/:conversationId` 的慢样本主要落在 29 日 23:19 上线、并持续到 30 日 10:59 的 `a1600184` 版本状态；同一版本内 iOS WKWebView 和 Chrome WebView 明显更快。该提交本身只涉及 drama CDN 实验，却同时出现未被该提交修改的 characters/profile/studio 变慢，因此更符合共享启动资源、网络/CDN、Telegram WebView 运行环境及样本结构共同抬高 P95，而不是这三个页面各自的业务接口同时回归。
2. **消息发送与重新生成的下降是另一条生成链路问题。** `messages` 在 `98eced45` 上 P95 110.64 秒，在样本最多的 `a1600184` 上 P95 60.49 秒；`regenerate` 在 `a1600184` 上 P95 51.66 秒。日报中的首 token 多数仍为 2–6 秒，慢点主要在完整流式生成阶段，指向生成供应商耗时、回复长度/会话上下文分布和流式收尾，而不是 Railway 请求接入或机器资源。
3. **Railway 资源瓶颈和失败部署可以排除。** 窗口内约 12 次 main 部署全部成功，无 crash；48 小时 CPU 平均 0.031 vCPU、峰值 0.160 vCPU，内存平均 0.265 GB、峰值 0.556 GB，相对 32 vCPU/32 GB 上限非常低。频繁部署和单副本带来的连接/缓存冷启动是次要放大因素，但不足以解释持续数小时的前端 P95。
4. **错误不是本轮页面 P95 上升的主因。** Sentry 日报中的应用请求 span 未见 4xx/5xx，但 `api.request_failed` 日志 724 条、依赖 `internal_error` 315 条；Railway 48 小时代理口径 5xx 为 151/49,111（0.31%），并在 29 日 16:48 出现一次 7.79% 的短时尖峰。它说明存在局部失败和依赖波动，但错误规模和时间分布均不能解释 23:19 后 Telegram Android 的持续导航尾延迟。

综合判断：**主因是 Telegram Android 主导的客户端/网络/共享资源尾延迟及样本结构变化；消息接口另有生成全链路尾耗时上升。高频发布/冷缓存是次因，Railway 资源不足、部署失败和单个页面业务 API 普遍变慢不是主因。**

## 2. 统计窗口与口径

- 日报窗口：北京时间 `2026-10-29 15:00` 至 `2026-10-30 15:00`，即 UTC `2026-10-29 07:00` 至 `2026-10-30 07:00`。
- 可用本地日报覆盖 26–30 日；24、25 日没有同目录日报，因此不能把周报标题误当作每天都有等价样本。
- 页面 navigation/pageload 是浏览器端完整导航口径，包含 WebView 调度、资源加载、网络和页面初始化；不能与单个 HTTP API P95 直接等同。
- `/create/studio/:conversationId` 29 日仅 5 个样本，30 日 45 个样本，“+1793%”有明显小样本基线放大，绝对值异常仍成立。

## 3. 30 日相对 29 日的关键变化

| 指标                             |    29 日 P95 |      30 日 P95 | 判断                           |
| -------------------------------- | -----------: | -------------: | ------------------------------ |
| `/characters` navigation         |        5.55s |         10.31s | 明显退化，30 日 n=330          |
| `/profile` navigation            |        4.78s |          7.86s | 明显退化，30 日 n=280          |
| `/create/studio/:conversationId` | 0.58s（n=5） | 10.98s（n=45） | 异常真实，涨幅被小样本放大     |
| `/dramas/:id` navigation         |            — |          7.01s | 偏慢，可能与 drama 改动相关    |
| `/chat/:characterId` navigation  |       12.19s |          9.40s | 实际改善 23%                   |
| `/` navigation                   |        8.14s |          5.37s | 实际改善 34%                   |
| `/` pageload                     |       28.38s |         15.30s | 实际改善 46%                   |
| `POST .../messages`              |       45.24s |         59.16s | 完整生成退化 31%               |
| `POST .../regenerate`            |       32.28s |         51.03s | 完整生成退化 58%               |
| `GET /api/support/unread`        |            — |          276ms | 健康，不是页面慢点             |
| `GET /api/characters`            |            — |        约 98ms | 健康，不能解释 10.31s 页面导航 |

因此“30 日性能全面下降”不成立。下降主要是 characters/profile/studio/drama 和完整生成接口；chat 与首页反而改善。

## 4. GitHub main 与 Railway 部署时间线

Railway 服务直接跟踪 `linshu368/ST_miniapp` 的 `main`，`checkSuites=false`，后端为单副本、Singapore 区域。以下 main 提交在 Railway 均生成成功部署；Sentry 页面 navigation 也能观察到相同 SHA 的 release，说明对应前端版本实际产生了用户流量。

| 北京时间    | SHA        | GitHub main 内容                          | 与本轮关系                                                                |
| ----------- | ---------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| 10-29 16:02 | `5dce05cc` | PR #543 character social                  | 新增角色社交 API/前端展示；16:48 代理错误率短时尖峰需关注                 |
| 17:22       | `b9d24418` | PR #544 drama telemetry unification       | drama 埋点与观测口径改动                                                  |
| 20:12       | `98eced45` | PR #548 conversation branches/reply likes | 会话分支/点赞；该 release 的 messages P95 最差                            |
| 21:30       | `6e5068f3` | PR #549 dev merge                         | 跨 support、drama、gallery、chat 的较大合并                               |
| 22:48       | `b12b745d` | PR #554 miniapp startup shell             | 启动壳与阶段计时                                                          |
| 22:53       | `cdda5833` | PR #552 entry performance                 | 入口、drama、character card/gallery、图片与页面追踪优化                   |
| 23:19       | `a1600184` | PR #555 drama CDN experiment              | 覆盖主要夜间/上午流量，慢样本最多，但提交未修改 profile/studio/characters |
| 10-30 10:59 | `734b5433` | PR #560 image plaza 400 compatibility     | studio/image plaza 兼容修复                                               |
| 11:19       | `5a81aa1a` | PR #564 chat recovery                     | chat 恢复逻辑                                                             |
| 11:22       | `8cbd10fe` | PR #565 chat dispatch production          | chat dispatch/generation                                                  |
| 12:17       | `e06636aa` | PR #569 check-in midnight                 | profile/check-in/payment                                                  |
| 14:47       | `94c2b66d` | PR #571 startup stages                    | 启动阶段观测；在日报窗口仅暴露 13 分钟                                    |

一天约 12 次生产替换会切碎样本，并反复更换前端静态资源版本、后端进程及连接池。它会增加冷缓存和少量部署窗口波动，但所有部署均成功，且没有资源饱和证据，故列为次因而非根因。

## 5. Sentry release 与设备证据

### 5.1 页面异常集中在版本和设备组合

`a1600184` 是 23:19 至次日 10:59 的长驻版本，也是大部分夜间/上午样本来源：

| 页面 / 设备（`a1600184`）                     |   p50 |    p95 | 样本数 |
| --------------------------------------------- | ----: | -----: | -----: |
| `/characters` / Telegram Android              | 3.46s |  9.79s |     80 |
| `/characters` / iOS WKWebView                 |     — |  2.19s |      5 |
| `/characters` / Chrome Mobile WebView Android |     — |  1.01s |      5 |
| `/profile` / Telegram Android                 | 2.23s |  7.71s |    150 |
| `/profile` / iOS WKWebView                    |     — |  3.61s |     15 |
| `/create/studio/:id` / Telegram Android       | 1.37s | 10.98s |     30 |
| `/create/studio/:id` / iOS WKWebView          |     — |  0.33s |      5 |

前一日报主要 release `eec9...` 中，Telegram Android `/characters` p95 为 5.79 秒（n=205）、`/profile` 为 4.99 秒（n=50）。相同设备上 30 日分别上升约 69% 和 54%，说明不只是跨设备样本占比变化，Telegram Android 自身的尾延迟也确实恶化。

不过异常并非每个后续 release 都持续：`/characters` 在 `6e5068f3`、`cdda5833`、`8cbd10fe` 的 p95 分别约 2.85、3.02、1.18 秒；`/profile` 的绝大多数慢样本来自长驻的 `a1600184`（p95 7.31 秒，n=180）。这更像共享前端资源/网络环境与 release 暴露时段的组合，而非角色列表接口本身。

### 5.2 普通 API 没有对应数量级的退化

- Grafana 日报末桶 `GET /api/characters` 约 98ms。
- `GET /api/image-plaza/conversations/:id` 在 `a1600184` p95 约 445ms。
- `GET /api/wallet/checkin` 在 `a1600184` p95 约 509ms。
- `GET /api/v1/conversations/:id` 在 `a1600184` p95 约 860ms。

这些接口均不足以单独解释 7–11 秒的页面 navigation，慢点应继续从共享 JS/图片资源、Telegram 网络/TLS、启动任务并发和 WebView 主线程长任务定位。

### 5.3 生成接口是独立问题

| release    | messages p50 / p95 / n | regenerate p50 / p95 / n |
| ---------- | ---------------------- | ------------------------ |
| `98eced45` | 54.96s / 110.64s / 35  | 43.09s / 45.37s / 10     |
| `a1600184` | 12.15s / 60.49s / 225  | 12.07s / 51.66s / 35     |
| `6e5068f3` | 11.94s / 47.64s / 170  | —                        |
| `b9d24418` | 15.27s / 42.19s / 140  | —                        |
| `e06636aa` | 10.77s / 16.65s / 55   | 40.29s / 42.29s / 10     |

同一台低负载 Railway 实例上，不同 release/请求分布差异很大；而日报首 token 多为 2–6 秒。这与“后端 CPU 慢”不符，更符合长回复、上下文复杂度、模型供应商尾延迟或流式结束阶段差异。`98eced45` 的异常值得单独用 trace 对齐会话分支改动，但当前聚合数据还不足以证明该提交是唯一因果。

## 6. Railway 与错误证据

- 48 小时 CPU：平均 `0.0311 vCPU`，峰值 `0.1595 vCPU`；内存：平均 `0.265 GB`，峰值 `0.556 GB`，均远低于 32 vCPU/32 GB 上限。
- 7 天 CPU 平均 `0.0493 vCPU`，内存平均 `0.303 GB`、峰值 `0.8895 GB`，30 日没有容量异常。
- 48 小时代理口径：49,111 请求中 151 个 5xx（0.31%）、389 个 4xx；最差 5xx 桶为 29 日 16:48 的 7.79%，时间上接近 16:02 的 character-social 部署，但并未持续到夜间主要慢样本期。
- 最新 500 条窗口内运行日志样本为 483 info、18 warn、无 error severity；该样本不是完整窗口，不能据此宣称所有运行日志均无错误。
- Sentry `api.request_failed` 按 release 绝对数以长驻的 `a1600184` 最高（237），但没有分母，不能直接当作该版本失败率；日报合计 724 条应继续按 `route/status/error.kind` 拆分。

## 7. 原因分级

### 已证实

- 30 日不是全面下降：首页和 chat navigation 改善，characters/profile/studio 与完整生成退化。
- 慢页面样本高度集中在 Telegram Android，且相同 release 下 iOS/Chrome WebView 更快。
- `a1600184` 覆盖了最多慢样本，但该提交本身未修改 characters/profile/studio。
- 普通页面 API 多为亚秒级；Railway CPU、内存没有压力；窗口内没有失败部署或 crash。
- messages/regenerate 的完整生成阶段存在 50–110 秒尾延迟。

### 强相关推断

- 页面主因是 Telegram Android 的网络/资源/运行环境尾延迟，加上共享启动资源或任务并发；频繁前端版本切换和冷缓存放大了 P95。
- 生成接口主因在 LLM/provider/回复长度或流式完成阶段，而非 Railway 容量。
- 29 日晚集中合并多个入口、启动、图片、drama、chat 改动，降低了单 commit 归因能力，也造成 release 样本碎片化。

### 尚不能验证

- 没有拿到 Vercel 每次 deployment 的精确 Ready 时间和 CDN cache 状态；Sentry release 仅能证明这些前端 SHA 实际产生了用户流量。
- Railway 日志只抽取最新 500 条，无法排除窗口早段的单请求错误。
- 未对具体慢导航 trace/replay 做资源 waterfall 与 long task 分解，因此不能在 CDN、Telegram 网络、图片、JS 主线程之间给出唯一比例。
- 没有 provider 请求维度的模型、token、输出长度和结束原因分组，不能把生成长尾唯一归因到某一家供应商。

## 8. 建议的下一步

1. 先保持生产版本稳定 2–4 小时，避免连续部署；按 `release + browser.name + os.name + connection.type` 观察 `/characters`、`/profile`、studio P95，验证冷缓存/版本切换影响。
2. 对 Telegram Android 的慢导航补齐或查询 `resource.*`、DNS/TCP/TLS、静态资源 cache hit、JS long task 和启动阶段耗时；从 `a1600184` 慢 trace 各抽 10 条与 iOS 快 trace 对照。
3. 将 `api.request_failed` 按 route、status、error.kind、dependency 和 release 计算失败率，不再只看绝对条数；重点复核 29 日 16:48 尖峰。
4. 对 messages/regenerate 按 provider/model、输入/输出 token、首 token、完整耗时、结束原因、release 分组；优先复核 `98eced45` 的 35 条 messages trace。
5. 发布层面合并生产部署批次，并启用 GitHub checks 通过后再部署；单副本后端如继续高频发布，增加 startup/readiness 与冷连接耗时观测，再决定是否需要双副本或预热，避免先扩容掩盖非容量问题。

## 9. 查询与证据入口

- 本地日报：`D:\JobExe\ST\sentry\2026-10\2026-10-30  3点前.md`
- 本地周报：`D:\JobExe\ST\sentry\2026-10\2026-10-24 至 2026-10-30 周性能报告.md`
- GitHub：`https://github.com/linshu368/ST_miniapp/commits/main`
- Sentry messages release 聚合：`https://wangqiao.sentry.io/explore/traces/?query=span.op%3Ahttp.server+AND+sentry.segment.name%3A%22POST+%2Fapi%2Fv1%2Fconversations%2F%3Aid%2Fmessages%22&project=4511818663788624&mode=aggregate&start=2026-10-29T07%3A00%3A00Z&end=2026-10-30T07%3A00%3A00Z`
- Sentry regenerate release 聚合：`https://wangqiao.sentry.io/explore/traces/?query=span.op%3Ahttp.server+sentry.segment.name%3A%22POST+%2Fapi%2Fv1%2Fconversations%2F%3Aid%2Fregenerate%22&project=4511818663788624&mode=aggregate&start=2026-10-29T07%3A00%3A00Z&end=2026-10-30T07%3A00%3A00Z`
- Railway：项目 `gallant-insight`，production / `stminiapp`，只读查询 deployment、HTTP、CPU、memory、network 与 runtime logs。
