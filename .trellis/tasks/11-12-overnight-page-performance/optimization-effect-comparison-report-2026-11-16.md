# 页面性能优化效果对比汇报（周一至周三 vs 周末）

编制日期：2026-11-16  
用途：汇报用对照摘要

## 1. 一句话结论

对比 **11/10–12（周一至周三）** 与 **11/14–15（周末）**：短剧详情挂载有所改善，大厅壳展示略好；但周四起 **`/chats` 成为冷启动主入口** 后，会话列表挂载与壳展示明显变差、样本暴增。Sentry **error/fatal** 与 **API timeout** 在更短的周末窗内仍高于周一至周三总量。**Grafana 站内导航主表本次未能登录重采**（见数据说明）；Railway 无可用 MCP/CLI，周末服务端数字沿用已核验报告作补充。

---

## 2. 对照窗口

| 项           | 周一至周三（优化观察前段）                                 | 周末（观察后段）                                          |
| ------------ | ---------------------------------------------------------- | --------------------------------------------------------- |
| 北京时间     | **2026-11-10 00:00 — 11-13 00:00**                         | **2026-11-14 00:00 — 11-16 00:00**（结束不含）            |
| UTC          | `2026-11-09T16:00:00Z` ≤ t `< 2026-11-12T16:00:00Z`        | `2026-11-13T16:00:00Z` ≤ t `< 2026-11-15T16:00:00Z`       |
| 时长         | **72 小时**                                                | **48 小时**                                               |
| 关键产品变化 | 周中合入请求优先级等；**周四前 `/chats` 尚未成落地主路径** | 已含周四落地 `/chats`+分组、增长提示；部署 SHA `47414e2f` |

**不可直接用绝对次数论输赢**：周末仅 2 天，流量密度更高；周四改了入口语义。优先看 **同口径 P95** 与结构变化。

---

## 3. 数据来源与本次采集说明

| 来源                                                      | 周一至周三 | 周末                                         | 说明                                                                                               |
| --------------------------------------------------------- | ---------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Sentry MCP**（本次现查）                                | ✓          | ✓                                            | `page.ready.duration`、`startup.shell_ready.duration`、error/fatal、`api.request.duration` timeout |
| **Grafana Faro**（`st_page_navigation` / launch / stall） | ✗ 未登录   | ✓ 沿用 [周末报告](./report-2026-11-14-15.md) | 本会话 **无 Grafana MCP**；浏览器打开 Grafana Cloud 停在登录页                                     |
| **Railway HTTP/5xx**                                      | ✗          | ✓ 沿用周末报告                               | Railway CLI 本机损坏；无 Railway MCP                                                               |

Sentry `page.ready.duration` = **挂载到内容可用**（毫秒），**不是** Grafana `st_page_navigation`（点击到可用）。壳指标 `startup.shell_ready.duration` 亦非文档到业务 ready。三者勿混用。

Sentry 查询组织：`wangqiao` / 项目 `st-miniapp` / region `https://de.sentry.io`。

---

## 4. 周四 / 周五相关提交（及紧邻性能提交）

周末生产 Backend 部署对齐：**`47414e2f`**。

### 4.1 周三 11/12（性能相关）

| Commit / PR                          | 内容                                | 含义                 |
| ------------------------------------ | ----------------------------------- | -------------------- |
| `f7621d81` / #770、`f0aa0826` / #771 | 请求优先级、错误处理、请求槽/分波等 | 进入周末前已在可达树 |
| `76b81dde` / #757                    | 短剧 Stream 持续预热                | 利于播放链           |
| `ca0d91c0` / #781                    | 快进音频并行拉取                    | 播放体验             |

### 4.2 周四 11/13（产品路径变化大）

| Commit         | 内容                                     | 含义                 |
| -------------- | ---------------------------------------- | -------------------- |
| **`09258916`** | 剧场合并；**落地 `/chats`**；分组/按角色 | 冷启动主入口切换     |
| **`befc10b9`** | 增长弹窗资格/事件                        | 新增后台读与 timeout |
| `47414e2f`     | 问卷样式等                               | 周末异常样本 release |

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

查询链接（周一至周三）：[Sentry Metrics page.ready](https://wangqiao.sentry.io/explore/metrics/?project=4511818663788624&start=2026-11-09T16%3A00%3A00Z&end=2026-11-12T16%3A00%3A00Z)

---

## 6. Sentry MCP：壳可展示 `startup.shell_ready.duration`

| 路由          | 周一至周三 Android | 周一至周三 iOS |   周末 Android |      周末 iOS | 观察                                                 |
| ------------- | -----------------: | -------------: | -------------: | ------------: | ---------------------------------------------------- |
| `/characters` |     **7.02 / 558** | **8.19 / 136** | **6.27 / 342** | **5.46 / 86** | 周末略好，仍多秒级                                   |
| `/chats`      |       1.23 / **3** |   9.54 / **2** | **4.91 / 482** | **4.42 / 84** | 周一至周三几乎无冷开样本；周末成为主壳路径且 **~5s** |

与 Grafana 文档冷启动（周末报告：`/chats` Android **8.28 / 436**、`/characters` **7.96 / 293**）方向一致：壳已慢，业务 ready 往往更慢。

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

## 8. Grafana / Railway 补充（周末已核验；周一至周三待登录补采）

### 8.1 Grafana 页面（仅周末侧有完整主表）

来自 [report-2026-11-14-15.md](./report-2026-11-14-15.md)：

| 指标                         | 周末 48h               |
| ---------------------------- | ---------------------- |
| ready / error / 卡住≥4s      | 7319 / 58 / 434        |
| `/chat` 导航 Android/iOS     | 4.57 / 781；3.51 / 128 |
| `/chats` 冷启动 Android      | 8.28 / 436             |
| `/characters` 冷启动 Android | 7.96 / 293             |

**周一至周三 Grafana `st_page_navigation` / `st_page_launch` / stall：本次未取得。** 若需补表，请登录 Grafana 后用：

`from=1794240000000&to=1794499200000`（周一至周三）  
看板示例：https://ea3213527545.grafana.net/d/st-five-route-navigation-ready?from=1794240000000&to=1794499200000&var-environment=production&var-tg_platform=android%7Cios

### 8.2 Railway（仅周末侧）

| 指标                  | 周末 48h                                              |
| --------------------- | ----------------------------------------------------- |
| HTTP                  | 337662                                                |
| 5xx                   | 43（**0.0127%**）                                     |
| 4xx                   | 1074（含 499×542）                                    |
| 业务 5xx 头几名       | first-token 13、messages 10+2、新建会话 7、详情 GET 5 |
| groups/详情服务端 P95 | ~0.23s / ~0.37s（客户端仍可达数秒 → 排队）            |

周一至周三 Railway 明细本次未拉到；不宜用七天旧窗冒充周一至周三。

---

## 9. 综合研判

### 9.1 相对周一至周三，周末的正向信号

1. **短剧详情** Sentry 挂载 P95 略降（样本仍不足）。
2. **聊天** 挂载 P95 略降，且周末样本远大于周一至周三。
3. **大厅壳** Android/iOS shell_ready 略好于周一至周三。
4. （周末报告补充）Railway 业务 5xx 占比已很低、无 OPTIONS 500 风暴。

### 9.2 相对周一至周三，周末需重点治理

1. **`/chats`**：挂载 Android 0.98s→2.81s；壳从几乎无样本变为 **~4.9s / N482**——对齐周四落地页。
2. **剧场列表** 挂载变差。
3. **error/fatal、API timeout** 强度上升；AbortError、growth/大厅 timeout 需分流治理。
4. Grafana 文档冷启动（周末）`/chats`/`/characters` 仍约 **8s**，未达 4s 目标。

### 9.3 与提交对应（汇报口径）

| 现象                              | 更可能相关                   | 不宜说成                           |
| --------------------------------- | ---------------------------- | ---------------------------------- |
| `/chats` 冷开/挂载恶化 + 样本暴涨 | `09258916` 落地+分组         | 「性能优化全面失败」               |
| timeout 强度上升                  | `befc10b9` + 大厅/详情压力   | 「Railway 全面变慢」               |
| 短剧挂载略好                      | Stream 预热等 + 其它播放改动 | 「单 commit 已证明因果」           |
| 请求槽已在树内                    | 周三优先级能力               | 「已自动覆盖 chats 首屏 critical」 |

---

## 10. 建议汇报话术

> 用 Sentry 现查对比 11/10–12 与 11/14–15：聊天与短剧详情挂载略有改善，大厅壳略好；但周四将对话页设为落地后，周末 `/chats` 挂载与壳展示显著变差且成为主流量。周末 48 小时 error/fatal 229、API timeout 974，均高于周一至周三 72 小时的 94 与 500。Grafana 导航主表需登录后补采周一至周三才能与周末导航 P95 正式并表；当前结论以 Sentry 挂载/壳/错误/超时为主，并与已核验的周末 Grafana/Railway 报告交叉。

---

## 11. 附件

- 周末完整 Grafana/Railway 审计：`./report-2026-11-14-15.md`
- 原因分析：`./analysis-and-remediation-2026-11-14-15.md`
- 后续开发设计：`./code-grounded-optimization-design.md`
- Sentry 周一至周三 errors：https://wangqiao.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=environment%3Aproduction+timestamp%3A%3E%3D2026-11-09T16%3A00%3A00Z+timestamp%3A%3C2026-11-12T16%3A00%3A00Z+level%3A%5Berror%2Cfatal%5D&project=4511818663788624&field=title&field=count%28%29&sort=-count%28%29&start=2026-11-09T16%3A00%3A00Z&end=2026-11-12T16%3A00%3A00Z&mode=aggregate&yAxis=count%28%29
- Sentry 周末 errors：https://wangqiao.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=environment%3Aproduction+timestamp%3A%3E%3D2026-11-13T16%3A00%3A00Z+timestamp%3A%3C2026-11-15T16%3A00%3A00Z+level%3A%5Berror%2Cfatal%5D&project=4511818663788624&field=title&field=count%28%29&sort=-count%28%29&start=2026-11-13T16%3A00%3A00Z&end=2026-11-15T16%3A00%3A00Z&mode=aggregate&yAxis=count%28%29

---

_Sentry 数字为 2026-11-16 经 MCP 现查；Grafana/Railway 周一至周三待补采后可再发一版并表。_
