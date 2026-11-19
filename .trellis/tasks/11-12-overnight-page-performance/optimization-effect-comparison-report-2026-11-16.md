# 页面性能优化效果对比（周一至周三 vs 周末）

编制日期：2026-11-16
用途：汇报用对照摘要

## 1. 一句话结论

对比 **11/10–12（周一至周三）** 与 **11/14–15（周末）**：短剧详情挂载有所改善，大厅壳展示略好；但周四起 `/chats` **成为冷启动主入口** 后，会话列表挂载与壳展示明显变差、样本暴增。Sentry **error/fatal** 与 **API timeout** 在更短的周末窗内仍高于周一至周三总量。服务端侧：**周一至周三仍有大量 OPTIONS 500（CORS 拒绝被记成 5xx）**，**周末 OPTIONS 500 已清零**，与周三晚 `Dev (#741)` 跨域改造成 403 分类对齐；周末残留 5xx 已是业务路由（first-token / messages / 新建会话等），不是预检风暴。

---

## 2. 对照窗口

| 项           | 周一至周三（优化观察前段）                                     | 周末（观察后段）                                          |
| ------------ | -------------------------------------------------------------- | --------------------------------------------------------- |
| 北京时间     | **2026-11-10 00:00 — 11-13 00:00**                             | **2026-11-14 00:00 — 11-16 00:00**（结束不含）            |
| UTC          | `2026-11-09T16:00:00Z` ≤ t `< 2026-11-12T16:00:00Z`            | `2026-11-13T16:00:00Z` ≤ t `< 2026-11-15T16:00:00Z`       |
| 时长         | **72 小时**                                                    | **48 小时**                                               |
| 关键产品变化 | 周中合入请求优先级等；**周四前** `/chats` **尚未成落地主路径** | 已含周四落地 `/chats`+分组、增长提示；部署 SHA `47414e2f` |

**不可直接用绝对次数论输赢**：周末仅 2 天，流量密度更高；周四改了入口语义。优先看 **同口径 P95** 与结构变化。

---

## 3. 数据来源与本次采集说明

| 来源                       | 周一至周三                            | 周末                                         | 说明                                                                                    |
| -------------------------- | ------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Sentry MCP**（本次现查） | ✓                                     | ✓                                            | 挂载/壳、error/fatal、API timeout、**Fastify OPTIONS/5xx span**、客户端 `http_5xx`      |
| **Grafana Faro**           | ✗ 未登录                              | ✓ 沿用 [周末报告](./report-2026-11-14-15.md) | 无 Grafana MCP                                                                          |
| **Railway HTTP/5xx**       | 部分：过夜窗 [report.md](./report.md) | ✓ [周末报告](./report-2026-11-14-15.md)      | 周一至周三完整 72h 访问日志未拉全；OPTIONS/5xx 结构用 Sentry span + 已核验 Railway 交叉 |

Sentry `page.ready.duration` = **挂载到内容可用**（毫秒），**不是** Grafana `st_page_navigation`。壳指标亦非文档到业务 ready。三者勿混用。

**服务端报错口径（强制分层）**：

1. **Railway 访问日志** = HTTP 状态绝对量（权威分母）
2. **Sentry** `span.op:request_handler.fastify` = 服务端 handler span，用于 OPTIONS/5xx **结构对比**（绝对次数可能受采样影响，**≠ Railway 条数**）
3. **Sentry** `api.request.duration` **outcome=**`http_5xx` = **客户端** timedFetch 见到的 5xx（不含浏览器 CORS 预检被拒本身）

Sentry 查询组织：`wangqiao` / 项目 `st-miniapp` / region `https://de.sentry.io`。

---

## 4. 周四 / 周五相关提交（及紧邻性能提交）

周末生产 Backend 部署对齐：`47414e2f`。

### 4.1 周三 11/11–11/12（CORS / 性能相关）

| Commit / PR                                | 内容                                                                       | 含义                                             |
| ------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `7b59c371` **/ #741**（11/11 17:52 +0800） | Dev 合入；非法 Origin **先 403**，不再 `callback(Error)` → OPTIONS **500** | **OPTIONS 500 清零主因候选**；与 span 日分布对齐 |
| `dc229209` / #740                          | Fix request speed（大厅/会话请求成本等）                                   | 同批性能合入                                     |
| `f7621d81` / #770、`f0aa0826` / #771       | 请求优先级、错误处理、请求槽/分波等                                        | 进入周末前已在可达树                             |
| `76b81dde` / #757                          | 短剧 Stream 持续预热                                                       | 利于播放链                                       |
| `ca0d91c0` / #781                          | 快进音频并行拉取                                                           | 播放体验                                         |

> 本地另有 `92050a45`（chat-reliability CORS）**未进** `origin/main`；生产以 `#741` 可达树中的 `registerCors`（非法 Origin → 403）为准。

### 4.2 周四 11/13（产品路径变化大）

| Commit     | 内容                                     | 含义                 |
| ---------- | ---------------------------------------- | -------------------- |
| `09258916` | 剧场合并；**落地** `/chats`；分组/按角色 | 冷启动主入口切换     |
| `befc10b9` | 增长弹窗资格/事件                        | 新增后台读与 timeout |
| `47414e2f` | 问卷样式等                               | 周末异常样本 release |

### 4.3 周五 11/14

主要为可观测性/日志合入与同 SHA 重建，**不是页面加速补丁**。

> 11/16 本地冷启动候选（rewrite + chats critical）**不在本对照窗内**。

---

## 5. Sentry MCP：挂载到可用 `page.ready.duration`

单位已换算为 **秒 / N**；仅 android/ios。

| 页面                   | 周一至周三 Android | 周一至周三 iOS |    周末 Android |       周末 iOS | 观察                                  |
| ---------------------- | -----------------: | -------------: | --------------: | -------------: | ------------------------------------- |
| 短剧详情 `/dramas/:id` |      **5.81 / 74** |  **7.92 / 14** |   **4.91 / 36** |   **7.06 / 9** | 两端略降；N 仍低                      |
| 聊天 `/chat/:id`       |     **2.74 / 634** | **2.12 / 215** | **2.40 / 1587** | **2.01 / 216** | 小幅改善，样本大增                    |
| 会话列表 `/chats`      |     **0.98 / 272** |  **2.64 / 77** | **2.81 / 1436** | **2.35 / 230** | **Android 明显变差**；周末流量暴涨    |
| 大厅 `/characters`     |        1.53 / 1237 |     1.44 / 370 |     1.54 / 1439 |     1.77 / 232 | 基本持平                              |
| 剧场 `/dramas`         |         1.26 / 216 |      1.22 / 52 |  **2.30 / 387** |      1.76 / 82 | Android 变差                          |
| 放映 `/watch`          |         1.52 / 230 |      1.35 / 47 |      0.06 / 162 |      0.01 / 35 | 周末挂载极快（口径/路径变化需防误解） |
| 个人中心 `/profile`    |        0.019 / 573 |    0.008 / 128 |     0.023 / 509 |     0.007 / 81 | 挂载一直很快                          |

---

## 6. Sentry MCP：壳可展示 `startup.shell_ready.duration`

| 路由          | 周一至周三 Android | 周一至周三 iOS |   周末 Android |      周末 iOS | 观察                                                 |
| ------------- | -----------------: | -------------: | -------------: | ------------: | ---------------------------------------------------- |
| `/characters` |     **7.02 / 558** | **8.19 / 136** | **6.27 / 342** | **5.46 / 86** | 周末略好，仍多秒级                                   |
| `/chats`      |       1.23 / **3** |   9.54 / **2** | **4.91 / 482** | **4.42 / 84** | 周一至周三几乎无冷开样本；周末成为主壳路径且 **~5s** |

---

## 7. Sentry MCP：错误与 API timeout

### 7.1 error / fatal 总量

| 窗口           |    次数 | 日均粗算（仅量级） |
| -------------- | ------: | ------------------ |
| 周一至周三 72h |  **94** | ~31 / 天           |
| 周末 48h       | **229** | ~115 / 天          |

周末窗更短，总量与日均都更高。

### 7.2 错误标题 Top（同口径 MCP）

| 标题（摘要）                           | 周一至周三 |                 周末 |
| -------------------------------------- | ---------: | -------------------: |
| AbortError: This operation was aborted |         38 |              **131** |
| TelegramGameProxy.receiveEvent         |         12 |               **35** |
| 查询会话消息失败                       |         18 |                    2 |
| parallelRoutes.get / null.get          |        6+4 | （周末主表未再居前） |
| ResizeObserver                         |          5 |                   27 |
| 首 token 观测失败                      |          3 |                   11 |
| findLast is not a function             |          2 |                    — |
| Worker importScripts                   |          3 |                    4 |
| crypto.randomUUID                      |          — |                    2 |

解读：周末 **取消类 AbortError** 与 **TelegramGameProxy** 上升；周一至周三仍可见旧兼容类错误。AbortError **不能**直接等于后端超时。

### 7.3 timedFetch API timeout

| 窗口       | `api.request.duration` outcome=timeout 次数 |
| ---------- | ------------------------------------------: |
| 周一至周三 |                                     **500** |
| 周末       |               **974**（与周末审计报告一致） |

周末 timeout 约为周一至周三的约 **1.95 倍**，而窗口更短 → 强度上升。周末报告拆解：lobby-characters 252、详情 183、growth/prompts 117——对齐周四增长上线与大厅/详情压力。按路由分组在 MCP 侧 `sentry.segment.name` 多为空，**拆路由以周末报告明细为准**。

---

## 8. OPTIONS / 5xx 服务端报错对比（本次补齐）

### 8.1 OPTIONS 预检（Sentry Fastify span，同口径）

过滤：`environment:production` + `span.op:request_handler.fastify` + `http.request.method:OPTIONS`。

| 指标                        | 周一至周三 72h | 周末 48h | 观察              |
| --------------------------- | -------------: | -------: | ----------------- |
| OPTIONS **204**（成功预检） |          45735 |   109350 | 周末流量更大      |
| OPTIONS **500**             |        **225** |    **0** | **预检 5xx 清零** |
| OPTIONS 500 / 全部 OPTIONS  |         ~0.49% |       0% | 结构改善明确      |

周一至周三 OPTIONS 500 **按北京日**（UTC 日界 = 北京 00:00）：

| 北京日           | OPTIONS 500（span） |
| ---------------- | ------------------: |
| 11/10（一）      |             **215** |
| 11/11（二）      |              **10** |
| 11/12（三）      |               **0** |
| 11/14–15（周末） |               **0** |

与 `7b59c371` **/ #741（11/11 17:52 +0800）** 将非法 Origin 改为 **403**、不再走 Fastify 默认 500 的时间线一致；11/11 仍有 10 次残量，11/12 起为 0。
过夜窗 Railway（11/11 19:00–11/12 10:09 北京，[report.md](./report.md)）：**5xx=0**，且出现 **OPTIONS 403×26**（拒绝被正确分类），**无 OPTIONS 500**——与 span 清零相互印证。

周末 Railway 4xx/5xx 明细（[report-2026-11-14-15.md](./report-2026-11-14-15.md)）：**无 OPTIONS 403、无 OPTIONS 500**（有少量 OPTIONS 499=客户端提前断开，不是 CORS 分类错误）。

> 不能据此宣称「所有来源 CORS 永久修好」；只能说：**正式对照窗内，OPTIONS 被记成 5xx 的风暴已消失**。非法探测在改造后应表现为 403，不再污染 5xx。

### 8.2 服务端 5xx 结构（去掉 OPTIONS 后）

**A. Sentry Fastify span（结构对比，非 Railway 绝对量）**

| 路由 / 状态                                          | 周一至周三 |    周末 |
| ---------------------------------------------------- | ---------: | ------: |
| `OPTIONS *` 500                                      |    **225** |   **0** |
| `GET /api/v1/conversations/:id` 500                  |         60 |     155 |
| `POST .../first-token` 500                           |         15 |      20 |
| `POST .../messages` 500+504                          |        5+5 |   10+10 |
| `POST /api/v1/conversations` 500                     |          5 |      10 |
| 其它（creator / community / groups / characters 等） |     若干×5 |  若干×5 |
| **非 OPTIONS 5xx 合计（span）**                      |    **100** | **220** |

解读：周一至周三 5xx **主体是 OPTIONS**（225/325≈69%）；周末 5xx **全部是业务路由**。周末 span 非 OPTIONS 次数高于周一至周三，但窗口更短、流量更大，且 **span ≠ Railway 条数**——绝对量以 Railway 为准。

**B. Railway 访问日志（权威绝对量）**

| 来源     | 窗口                                           |   HTTP |               5xx | OPTIONS 500 | 说明                |
| -------- | ---------------------------------------------- | -----: | ----------------: | ----------: | ------------------- |
| 过夜审计 | 11/11 19:00–11/12 10:09 北京（周一至周三子集） |  26776 |             **0** |       **0** | 已有 OPTIONS 403×26 |
| 周末审计 | 11/14–15 完整 48h                              | 337662 | **43（0.0127%）** |       **0** | 业务 5xx            |

周末 Railway 5xx 路由（43 条全量，与桶统计一致）：

| 路由                                                                      | 次数 |
| ------------------------------------------------------------------------- | ---: |
| `500 POST .../first-token`                                                |   13 |
| `500 POST .../messages`                                                   |   10 |
| `500 POST /api/v1/conversations`                                          |    7 |
| `500 GET .../conversations/:id`                                           |    5 |
| `504 POST .../messages`                                                   |    2 |
| 其它（community/groups/plans/regenerate/generation-config/PATCH message） | 各 1 |

状态：500×40、503×1、504×2。完整推流 SSE 内错不一定表现为 HTTP 5xx。

**周一至周三完整 72h Railway 访问日志本次未拉全**；不宜用七天旧窗（525×5xx、其中 OPTIONS 490）直接当本对照窗分母。旧七天只作历史背景：OPTIONS 500 曾占 5xx 的 93%。

### 8.3 客户端见到的 `http_5xx`（timedFetch，非 OPTIONS）

| 路由                                                          | 周一至周三 |   周末 |
| ------------------------------------------------------------- | ---------: | -----: |
| `/api/v1/conversations/:id`                                   |         18 |      4 |
| `/api/v1/conversations`                                       |          1 |      7 |
| `/api/v1/conversations/:id/first-token`                       |          — |      2 |
| `/api/creator/characters/:id`                                 |          1 |      — |
| 其它（community/plans/generation-config/groups/messages/:id） |          — |   各 1 |
| **合计**                                                      |     **20** | **18** |

客户端 5xx 远少于服务端 span/Railway，因采样、未走到 timedFetch、或预检失败根本不会进入业务 fetch。**不能**用客户端 20/18 否定服务端 OPTIONS 225→0 的改善。

### 8.4 Grafana 页面（仅周末侧有完整主表）

来自 [report-2026-11-14-15.md](./report-2026-11-14-15.md)：

| 指标                         | 周末 48h               |
| ---------------------------- | ---------------------- |
| ready / error / 卡住≥4s      | 7319 / 58 / 434        |
| `/chat` 导航 Android/iOS     | 4.57 / 781；3.51 / 128 |
| `/chats` 冷启动 Android      | 8.28 / 436             |
| `/characters` 冷启动 Android | 7.96 / 293             |

**周一至周三 Grafana 导航主表本次未取得。** 补采：`from=1794240000000&to=1794499200000`
https://ea3213527545.grafana.net/d/st-five-route-navigation-ready?from=1794240000000&to=1794499200000&var-environment=production&var-tg_platform=android%7Cios

---

## 9. 综合研判

### 9.1 相对周一至周三，周末的正向信号

1. **短剧详情** Sentry 挂载 P95 略降（样本仍不足）。
2. **聊天** 挂载 P95 略降，且周末样本远大于周一至周三。
3. **大厅壳** Android/iOS shell_ready 略好于周一至周三。
4. **OPTIONS 500：225 → 0**；周末 Railway 亦无 OPTIONS 500/403；5xx 不再被 CORS 预检污染。

### 9.2 相对周一至周三，周末需重点治理

1. `/chats`：挂载 Android 0.98s→2.81s；壳从几乎无样本变为 **~4.9s / N482**——对齐周四落地页。
2. **剧场列表** 挂载变差。
3. **error/fatal、API timeout** 强度上升；AbortError、growth/大厅 timeout 需分流治理。
4. Grafana 文档冷启动（周末）`/chats`/`/characters` 仍约 **8s**，未达 4s 目标。
5. **业务 5xx**（Railway 43）：优先 first-token / messages / 新建会话，与页面 timeout 分流，不要再当成 CORS。

### 9.3 与提交对应（汇报口径）

| 现象                              | 更可能相关                   | 不宜说成                           |
| --------------------------------- | ---------------------------- | ---------------------------------- |
| OPTIONS 500 清零                  | `#741` / `7b59c371` CORS→403 | 「页面性能优化直接消灭了 5xx」     |
| `/chats` 冷开/挂载恶化 + 样本暴涨 | `09258916` 落地+分组         | 「性能优化全面失败」               |
| timeout 强度上升                  | `befc10b9` + 大厅/详情压力   | 「Railway 全面变慢」               |
| 周末业务 5xx 仍在                 | 会话/生成链路                | 「服务端已无 5xx」                 |
| 短剧挂载略好                      | Stream 预热等 + 其它播放改动 | 「单 commit 已证明因果」           |
| 请求槽已在树内                    | 周三优先级能力               | 「已自动覆盖 chats 首屏 critical」 |

---

## 10. 建议汇报话术

> 对比 11/10–12 与 11/14–15：聊天与短剧详情挂载略有改善，大厅壳略好；但周四将对话页设为落地后，周末 `/chats` 挂载与壳展示显著变差。错误侧：周末 error/fatal 229、API timeout 974，高于周一至周三的 94 与 500。服务端报错结构则明显改善——周一至周三 Sentry Fastify 仍见 OPTIONS 500×225（集中在 11/10–11），周末为 0，与周三晚 #741 跨域改 403 对齐；周末 Railway 337662 次请求仅 43 次业务 5xx（0.0127%），无 OPTIONS 500。页面慢与 CORS 5xx 已拆开：前者盯 chats 冷开与排队，后者盯 first-token/messages。

---

## 11. 附件

- 周末完整 Grafana/Railway 审计：`./report-2026-11-14-15.md`
- 过夜窗 Railway（周一至周三子集，0×5xx / OPTIONS 403）：`./report.md`
- 原因分析：`./analysis-and-remediation-2026-11-14-15.md`
- 后续开发设计：`./code-grounded-optimization-design.md`
- Sentry 周一至周三 OPTIONS/5xx spans：https://wangqiao.sentry.io/explore/traces/?query=environment%3Aproduction+timestamp%3A%3E%3D2026-11-09T16%3A00%3A00Z+timestamp%3A%3C2026-11-12T16%3A00%3A00Z+span.op%3Arequest_handler.fastify+http.status_code%3A%3E%3D500&project=4511818663788624&mode=aggregate&start=2026-11-09T16%3A00%3A00Z&end=2026-11-12T16%3A00%3A00Z&table=span
- Sentry 周末 OPTIONS/5xx spans：https://wangqiao.sentry.io/explore/traces/?query=environment%3Aproduction+timestamp%3A%3E%3D2026-11-13T16%3A00%3A00Z+timestamp%3A%3C2026-11-15T16%3A00%3A00Z+span.op%3Arequest_handler.fastify+http.status_code%3A%3E%3D500&project=4511818663788624&mode=aggregate&start=2026-11-13T16%3A00%3A00Z&end=2026-11-15T16%3A00%3A00Z&table=span
- Sentry 周一至周三 errors：https://wangqiao.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=environment%3Aproduction+timestamp%3A%3E%3D2026-11-09T16%3A00%3A00Z+timestamp%3A%3C2026-11-12T16%3A00%3A00Z+level%3A%5Berror%2Cfatal%5D&project=4511818663788624&field=title&field=count%28%29&sort=-count%28%29&start=2026-11-09T16%3A00%3A00Z&end=2026-11-12T16%3A00%3A00Z&mode=aggregate&yAxis=count%28%29
- Sentry 周末 errors：https://wangqiao.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=environment%3Aproduction+timestamp%3A%3E%3D2026-11-13T16%3A00%3A00Z+timestamp%3A%3C2026-11-15T16%3A00%3A00Z+level%3A%5Berror%2Cfatal%5D&project=4511818663788624&field=title&field=count%28%29&sort=-count%28%29&start=2026-11-13T16%3A00%3A00Z&end=2026-11-15T16%3A00%3A00Z&mode=aggregate&yAxis=count%28%29

---

_Sentry 数字为 2026-11-16 经 MCP 现查（含 OPTIONS/5xx span 与客户端 http_5xx）；Railway 周末与过夜子集沿用已核验报告；周一至周三完整 Railway 访问日志待补采后可再收紧绝对量。_
