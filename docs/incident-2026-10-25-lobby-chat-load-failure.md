# 事故总结：2026-10-25 大厅/角色/对话加载失败

> 排查日期：2026-10-26  
> 证据来源：用户截图（Railway/结构化 warn）、Sentry MCP（org `wangqiao` / project `st-miniapp` / region `de`）、本地代码对照  
> 状态：根因已定性；处理措施待落地与复验  
> 关联规划：[production-request-performance-plan.md](./production-request-performance-plan.md)、`.trellis/tasks/10-21-sentry-ux-monitoring/dashboard-and-runbook.md`

---

## 1. 摘要

**2026-10-25** 出现用户侧集中反馈：

- 大厅列表无法加载 / 角色打不开
- 打开角色卡显示 **「对话加载失败，请重试」**

**主因**：客户端到 Railway 生产后端（`stminiapp-production.up.railway.app`）出现间歇性连通/排队超时。前端按约定超时 abort 后展示失败文案。业务 SQL / 大厅列表逻辑本身在多数已到达 handler 的样本上并不慢。

**非主因（易误判）**：截图中的  
`call identity unavailable; manual audit required`  
（`chathistory_sync.identity_missing`）属于 **chat-history-sync 计费对账告警**，不会阻断大厅/对话读接口；最多说明同窗可能有进程中断，作为旁证即可。

**影响峰值**：北京时间约 **13:00**（UTC 05:00）前后，直连 Railway 且 >10s 的客户端 span 约 **55** 次；晚间仍有零星对话详情 10s 超时。Sentry 指标告警 [ST-MINIAPP-3W](https://wangqiao.sentry.io/issues/ST-MINIAPP-3W)（P0-2 流量断崖）在当日多次触发。

---

## 2. 现象与用户路径

| 用户感知                 | 前端触发条件                                                                      | 关键接口                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 大厅列表加载失败         | `GET /api/lobby-characters`（Vercel 同源代理 → 后端 `/api/characters`）超时或失败 | 大厅首屏                                                                                                   |
| 角色打不开 / 详情慢      | `GET /api/characters/:id` 等超时                                                  | 角色卡 / 详情                                                                                              |
| 「对话加载失败，请重试」 | `conversationQuery.isError`（非 `session_not_found`）                             | `GET /api/v1/conversations/:sessionId`，默认 **10s** `AbortSignal.timeout`（见 `fetchConversationDetail`） |
| 通用 API 失败            | `apiClient` 默认 **20s** 超时（`DEFAULT_REQUEST_TIMEOUT_MS`）                     | 收藏、badge、通知未读等旁路                                                                                |

文案出处：`packages/frontend/src/hooks/use-chat-session.ts`（`entryError`）。

---

## 3. 情况分析

### 3.1 时间线（北京时间，UTC+8）

| 时间                               | 事件                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| 约 08:35–08:57（UTC 00:35–00:57）  | [ST-MINIAPP-44](https://wangqiao.sentry.io/issues/ST-MINIAPP-44)「对话生成失败增多」窗口尾部       |
| **10:33**（UTC 02:33）             | 截图 warn：`chathistory_sync.identity_missing`，history id `023f2241-d915-4d0c-bb60-58d3c7ff1752`  |
| **13:00 前后**（UTC 05:00）        | Railway 直连客户端 >10s span **≈55**（当日最大尖峰）                                               |
| 13:39（UTC 05:39）                 | 典型 trace：多接口客户端 ~20s 超时，服务端 handler 仅数十～数百 ms                                 |
| 19:08 / 21:31（UTC 11:08 / 13:31） | `lobby-characters` 客户端慢请求（约 6–10s）                                                        |
| 23:20（UTC 15:20）                 | 对话详情 GET 精确 **10008ms** 超时 → 对应「对话加载失败」路径                                      |
| 当日多次                           | [ST-MINIAPP-3W](https://wangqiao.sentry.io/issues/ST-MINIAPP-3W) 流量断崖（评估值 0，阈值 &lt;50） |

### 3.2 证据链

#### A. 客户端超时 vs 服务端快（核心）

代表 trace：[83040632a1604972a26c867b15fdd7b3](https://wangqiao.sentry.io/explore/traces/trace/83040632a1604972a26c867b15fdd7b3)（UTC 05:39）

同一导航内同时超时：

- `GET /api/characters/:id`、`GET /api/v1/conversations`、`latest-badge`、`favorites/ids`、`support/unread` 等
- **客户端 span ≈ 20s**（命中默认请求超时）
- **已进入 Fastify 的 server span ≈ 27–365ms**

结论：瓶颈在「连上后端 / 拿到完整响应之前」（边缘排队、连接建立、进程未及时 accept、或网络路径），**不是**大厅排序 SQL 常态变慢。

#### B. 「对话加载失败」精确复现

代表 trace：[75191deca9c74755942d8eb5bec6a7f2](https://wangqiao.sentry.io/explore/traces/trace/75191deca9c74755942d8eb5bec6a7f2)（UTC 15:20）

- `GET .../api/v1/conversations/{sessionId}` → **10008ms** 后失败
- **无对应 server span** → 请求未正常完成到业务 handler
- 与 `fetchConversationDetail(..., 10_000)` 行为一致

#### C. 入口流量断崖

[ST-MINIAPP-3W](https://wangqiao.sentry.io/issues/ST-MINIAPP-3W)：入口流量跌到接近 0，与「整体打不开」体感一致。该告警在 10/25 仍 unresolved / regressed。

#### D. 截图 `identity_missing` 的正确定位

代码：`packages/backend/src/features/generation/sync-job.ts`

- 后台 job 扫描未完成 chat history
- 若缺 `generationId` 且无法安全释放扣费 → `warn` + `manual audit required` + `continue`
- **不参与** 读大厅 / 读会话详情的请求路径

旁证意义：同窗可能有生成中进程中断（崩溃、重启、强杀），导致 call identity 丢失，需人工关账。

### 3.3 与同周历史问题的关系（勿混为一谈）

| 时间     | 问题                                          | Issue / 会话                                                                       | 与 10/25 关系                                        |
| -------- | --------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 10/15    | Prisma 连接池超时 → `GET /api/characters` 500 | 历史排查会话；池 `pool_timeout=10s`                                                | **同类用户感知**，机制不同（池耗尽 vs 客户端连不上） |
| 10/22    | 数据库连接池耗尽告警                          | [ST-MINIAPP-3Z](https://wangqiao.sentry.io/issues/ST-MINIAPP-3Z)                   | 容量风险仍在，10/25 主证据不指向池满                 |
| 10/22–23 | 核心接口 5xx 激增                             | [ST-MINIAPP-3X](https://wangqiao.sentry.io/issues/ST-MINIAPP-3X)                   | 已 resolved；说明同周稳定性承压                      |
| 既有规划 | 大厅长尾、排序 job 占池、N+1                  | [production-request-performance-plan.md](./production-request-performance-plan.md) | **治理项仍应推进**；可降低「一有抖动就雪崩」的概率   |

**定性**：10/25 用户可见故障 = **到 Railway 的间歇性超时尖峰**；同周连接池 / 5xx / 排序长事务是**放大因子与相关风险**，不是本事件唯一充分条件。

### 3.4 根因判断（置信度）

| 判断                                                      | 置信度 | 说明                                                  |
| --------------------------------------------------------- | ------ | ----------------------------------------------------- |
| 用户文案由前端超时/请求失败直接引起                       | 高     | 代码路径与 10008ms / ~20s 样本对齐                    |
| 当日存在 Railway 路径可用性抖动                           | 高     | 流量断崖 + 多路由同时客户端超时 + server 已处理却极快 |
| `identity_missing` 导致大厅/对话读失败                    | 排除   | 代码路径无关                                          |
| 具体触发器（单次 deploy / OOM / 平台网络 / 事件循环阻塞） | 中低   | 需对照 Railway 同时段 metrics / deploy 历史补齐       |

---

## 4. 处理措施

按「止血 → 查清 → 加固 → 关账」排列。标注 **OPS**（运维）、**ENG**（工程）、**CS**（客服/产品口径）。

### 4.1 立即（止血与取证）— 目标 1 个工作日

| #   | 动作                                                                                                                                                               | 负责人 | 验收                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------- |
| I1  | 对照 Railway：**2026-10-25 UTC 05:00（北京 13:00）±2h** 的 deploy、restart、CPU、内存、网络、副本数、连接数                                                        | OPS    | 留下截图/导出；标出是否与超时尖峰重合                                             |
| I2  | 同一窗口查 Supabase / Supavisor：连接数、池超时、是否有长事务（排序 job / 聚合）                                                                                   | OPS    | 与 [performance plan](./production-request-performance-plan.md) §5 两层预算表对照 |
| I3  | Sentry 复盘：`http.client` + `server.address:stminiapp-production.up.railway.app` + `span.duration:>10s` 按小时；对比前端 `api.request.duration` `outcome:timeout` | ENG    | 形成「超时是否复现」当日曲线                                                      |
| I4  | 人工审计 history `023f2241-d915-4d0c-bb60-58d3c7ff1752` 计费状态（扣费是否悬挂）                                                                                   | ENG    | 关账或记入待审计清单；**勿对用户宣称「已解决」除非工程确认**                      |
| I5  | 客服口径：说明「昨天中午左右访问后端不稳定，重试或稍后再开通常可恢复」；不提 AI/表名/日志细节                                                                      | CS     | 统一话术                                                                          |

### 4.2 短期（降低再发与误判）— 目标 1–2 周

| #   | 动作                                                                                                                  | 负责人 | 说明                                      |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------- |
| S1  | **落地连接治理 P0/P1**：排序/长事务移出请求共享池；有界等待；避免部署后长事务与流量叠加雪崩                           | ENG    | 见 performance plan；10/22 已有池耗尽先例 |
| S2  | 大厅代理 `lobby-characters`：为上游 `fetch` 增加明确超时与失败响应（避免无界挂死）                                    | ENG    | 当前 `route.ts` 未设 AbortSignal          |
| S3  | 区分监控：前端超时 vs 后端 `http.server.duration` p95 看板并列（runbook 已建议）；对「server 快 / client 慢」单独告警 | ENG    | 避免再把网络抖动误判成业务慢查询          |
| S4  | 为 `chathistory_sync.identity_missing` 建审计队列/仪表，勿与 P0 入口告警混在同一值班优先级                            | ENG    | 防止值班被旁路 warn 带偏                  |
| S5  | 确认生产 uptime 探活域名指向 **用户真实入口**（`app.themijing.com`），而非仅 Vercel 默认域名                          | OPS    | runbook T8 已提示缺口                     |

### 4.3 中期（体验韧性）— 随性能规划批次

| #   | 动作                                                                                | 说明                             |
| --- | ----------------------------------------------------------------------------------- | -------------------------------- |
| M1  | 消 `/chats` N+1（[ST-MINIAPP-1Y](https://wangqiao.sentry.io/issues/ST-MINIAPP-1Y)） | 减少入场并发，降低抖动时的雪崩面 |
| M2  | 大厅本地缓存 + 失败可重试 UI 统一（列表/对话详情）                                  | 超时后用户有明确重试路径         |
| M3  | 评估对话详情超时策略：弱网可区分「加载中/超时」与有限自动重试（需防风暴）           | 改超时前先有基线                 |
| M4  | 发布窗口与重负载后台 job 错峰；副本滚动时观察入口流量与 timeout 率                  | 与流量断崖告警联动               |

### 4.4 不做 / 暂缓

- 不因本事件单独盲目调大 `connection_limit`（performance plan E20/E21：稳态不缺容量，缺的是时间分布上的突发）
- 不把 `identity_missing` 当成读接口故障根因去改大厅/会话查询
- 不在无 Railway 同时段证据前断言「纯代码 bug」或「纯平台故障」

---

## 5. 复验清单

故障窗口或发版后，至少满足：

1. **Sentry**：北京高峰时段，Railway 直连 `http.client` `duration:>10s` count 回落到日常基线；`ST-MINIAPP-3W` 不再持续触发。
2. **对照**：同窗口后端 `http.server.duration`（`kind:standard`）p95 仍正常时，前端 `outcome:timeout` 应接近 0——否则继续查边缘/网络。
3. **人工**：大厅冷启动、打开角色卡进会话、失败后点「重试」三条路径可通。
4. **计费**：`identity_missing` 样例已审计关闭或列入已知清单。

---

## 6. 对外 / 对内一句话

- **对内**：10/25 用户打不开大厅与对话，主因是到 Railway 的间歇超时（北京约 13 点尖峰）；截图 identity 日志是计费旁路，不是读失败根因；同周池与 5xx 问题需按既有性能规划继续治。
- **对外（客服）**：昨天有一段时间连服务器不稳定，会出现列表或对话加载失败；请重试，若仍不行把大概时间和账号发给我们继续查。

---

## 7. 参考链接

| 资源                        | URL / 路径                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 流量断崖                    | https://wangqiao.sentry.io/issues/ST-MINIAPP-3W                                                                                                    |
| 对话生成失败增多            | https://wangqiao.sentry.io/issues/ST-MINIAPP-44                                                                                                    |
| 核心 5xx（同周）            | https://wangqiao.sentry.io/issues/ST-MINIAPP-3X                                                                                                    |
| 连接池耗尽（同周）          | https://wangqiao.sentry.io/issues/ST-MINIAPP-3Z                                                                                                    |
| 典型 client 20s / server 快 | https://wangqiao.sentry.io/explore/traces/trace/83040632a1604972a26c867b15fdd7b3                                                                   |
| 对话详情 10s 超时           | https://wangqiao.sentry.io/explore/traces/trace/75191deca9c74755942d8eb5bec6a7f2                                                                   |
| Railway >10s 客户端趋势     | https://wangqiao.sentry.io/explore/traces/?query=span.op%3Ahttp.client+server.address%3Astminiapp-production.up.railway.app+span.duration%3A%3E10s |
| 性能治理规划                | `docs/production-request-performance-plan.md`                                                                                                      |
| UX 监控 runbook             | `.trellis/tasks/10-21-sentry-ux-monitoring/dashboard-and-runbook.md`                                                                               |
