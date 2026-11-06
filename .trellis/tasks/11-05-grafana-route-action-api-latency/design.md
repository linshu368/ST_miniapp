# 技术设计

## 1. 范围与产物

在现有 Grafana/Faro/Loki/OTLP/Mimir 体系内增加五份 dashboard source：

1. `st-secondary-page-latency.json`
2. `st-tertiary-page-latency.json`
3. `st-button-response-latency.json`
4. `st-api-latency-non-stream.json`
5. `st-stream-api-latency.json`

页面与接口看板只增加查询，不改业务运行时。唯一候选运行时代码改动是把现有九个 `startAction` 关键动作全部投影到已有 Faro 工程出口，并在动作开始时冻结安全 route template/canonical entry；不新增 SDK、网络请求或状态源。

## 2. 复用调研

- 页面：复用 `ENGINEERING_PAGE_ROUTES`、`page.navigation`、`page.launch`、`page.terminal`、`page.stall` 与现有 Android/iOS `tg_platform`。不新增 route-ready 指标或页面 hook。
- 五入口：复用 `BottomNav` 和 `frontend.infrastructure.client-ui-foundation` 已确认的 `/watch`、`/dramas`、`/characters`、`/creation`、`/profile`。
- 按钮：复用 `action-tracker.ts` 的单调时钟、后台扣时、2.5s stall、幂等 feedback/discard 与九个有限 action enum。不做 DOM 自动采集。
- 普通 API：复用浏览器 `api.total/api.terminal` 与服务端 `st_http_server_duration_seconds/st_http_server_requests_total`；二者分别表示客户端总等待和 Fastify handler/流生命周期，不做分位数相减。
- SSE：复用 `roleplay.first_token/full_reply/terminal` 的 `action=send|regenerate`、服务端 generation route duration，以及 `creator.polish.headers/first_text/full/terminal`。
- Grafana 结构：复用 `st-five-route-navigation-ready.json` 的 2 秒阈值、样本量与 terminal 防幸存者偏差布局，以及四张 engineering dashboard 的 environment/release/platform 变量。
- 检索过的 hooks/helpers/contracts/features/repositories/DB：`usePageReady`、`startAction`、`apiClient` timing、`conversation-stream`、creator polish stream、Fastify request perf、generation observability。无需改 shared contract、feature、repository 或数据库函数；不新增 migration。

## 3. 路由层级

层级是产品 canonical ownership，不按 URL 斜杠数量推断。一级入口本身不出现在二/三级看板。

| 入口          | 二级页面                                                                                                                        | 三级页面                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `/watch`      | 无独立二级 route；到完整短剧归 `/dramas`                                                                                        | 无                                                                        |
| `/dramas`     | `/dramas/:id`                                                                                                                   | 无                                                                        |
| `/characters` | `/chats`、`/chat/:id`、`/creators/:id`、`/wishes`                                                                               | `/chat/:id/voice/:id`、`/wishes/:id`                                      |
| `/creation`   | `/create`、`/creation/characters/new`、`/creation/data`                                                                         | `/create/studio/:id`、`/create/work/:id`、`/creation/characters/:id/edit` |
| `/profile`    | `/vip`、`/profile/recharge`、`/profile/orders`、`/profile/spending`、`/profile/messages`、`/profile/invite`、`/profile/support` | `/profile/recharge/:id`、`/profile/messages/:id`                          |

共享入口采用 canonical owner：`/wishes*` 归角色模块，`/vip` 和充值归个人中心。查询使用固定 route 正则；新增页面不会自动进入错误层级，必须审核后显式登记。

## 4. 指标定义与看板布局

每份看板统一包含：口径说明、全窗口 P95、≤2秒占比、P95 趋势、成功样本 N、终态/失败/stall 分布。P95 图加 2000ms threshold；N<100 标低样本，不自动判稳态。

### 4.1 二/三级页面

- 主值：`st_page_navigation`、`outcome=ready`、`visibility=foreground`，按 route/tg_platform。
- 辅助：`st_page_launch` 只展示直接/冷打开；`st_page_terminal/stall` 检查分母。
- 不将 `page.ready`、`page.launch`、`page.navigation` 三种起点混为一个 P95。

### 4.2 关键按钮

- 继续使用既有 `st_roleplay_action` 名称以保持历史 dashboard 兼容，但从新 release 起覆盖全部九个关键动作。
- action 开始时冻结 route/entry；feedback 后记录前台有效等待，discard/stall 单列。
- dashboard 按 entry、route、action、tg_platform 展示。旧 release 中非角色动作无 Grafana 数据、route 曾硬编码 `/chat/:id`，必须按 release 分窗。

### 4.3 非流式 API

- 客户端：`st_api_total` 按 `api_route/method/tg_platform`，反映队列、有限重试、headers、body/解析的总等待。
- 服务端：`st_http_server_duration_seconds` 按 route/method/status，使用明确的流式 route 排除正则；不只用 `kind=standard`，避免把非 SSE 的生成 route 一并排除。
- `/api/telemetry/*` 继续排除，避免观测反馈环；SSE messages/regenerate 与 creator polish NDJSON 从普通 2 秒 SLO 移出。

### 4.4 SSE/流式 API

- send/regenerate：客户端 `roleplay.first_token` 是 2 秒主指标；`roleplay.full_reply` 和服务端完整 stream duration 仅诊断。
- creator polish：`headers` 与 `first_text` 是 2 秒主指标；`full` 仅诊断。界面明确标记它是 NDJSON，不冒称 SSE。
- 失败、超时、主动取消、后台和离页不填 0；首字成功 P95 与 terminal 样本同时读。

## 5. 不影响原性能的设计

- Dashboard JSON 只在 Grafana 查询时执行，对 MiniApp/Backend 请求链无运行时开销。
- 不增加 fetch、React Query、Fastify hook、SSE parser、数据库读写、定时轮询或全局 click listener。
- action 复用现有时钟和反馈点；只多构造有限字符串并进入现有 Faro 有界队列。SDK 未启用时 no-op；队列上限 64、payload 上限 2KiB、加载/发送失败直接丢弃。
- 记录 route template 与五个固定 entry，不记录 URL/query/ID/文案；不会造成 Loki label/cardinality 爆炸。
- dashboard 默认 24h、5m refresh，避免高频长窗 LogQL；全窗口 P95 用 `$__range`，趋势用 `$__auto`，不平均 P95。
- 性能停止条件：新增同步异常、业务结果变化、Faro dropped/transport failure 激增、页面/API/SSE P95 同 release 稳定窗口回退 >5%。满足任一项立即回退 action 投影；看板 JSON 可独立保留或回退。

## 6. 可靠性设计

- 超时/重试：不改变任何业务 timeout/retry；Grafana 查询失败显示 no data/error，不触发业务重试。
- 幂等/并发：沿用 action handle 的 settle-once 与 pending latest-wins；dashboard 无写入。
- 事务/补偿：无数据库和业务写入，不适用。
- 降级：Exporter/Sentry/Grafana 任一不可用均不影响业务；遥测允许丢失，不能作为计费、恢复或用户成功事实。
- 限流/容量：有限 route/action/entry/platform；不引入 ID label。Grafana 默认有界窗口。
- 可观测性：成功 P95、N、失败/离页/stall 与 exporter health 联合显示；避免成功幸存者偏差。

## 7. 最小充分方案与拒绝项

新增五份 JSON、一段 runbook 说明，并定点扩展现有 action mirror。拒绝引入 Tempo/新 SDK、新 dashboard provisioning 服务、数据库聚合表、全局按钮自动采集、通用页面层级框架或自动 URL 推断。静态映射虽然需要新增路由时人工维护，但最符合当前有限路由规模和低基数安全要求。

## 8. 演进、发布与恢复

- 兼容：现有指标名与旧 dashboard 保留；新 action route/entry 仅对新 release 生效，旧数据不回填。
- 顺序：action 安全投影（如审核保留）→ TEST/preview 收样本 → 导入五份 dashboard → 按 release 验证 → 生产导入。
- 停止条件：查询字段与 Cloud 实际格式不符、数据源无权限、指标量异常、任何业务 P95 >5% 回退或高基数/敏感字段风险。
- 回滚：先回退 action tracker/grafana enum；dashboard JSON 可独立撤销。无 migration、旧数据转换或业务补偿。
- Cloud 写入需要既有权限；无权限时只交付 JSON 与导入命令/步骤，不能声称线上已发布。

## 9. 可验证性

- 修改既有 `action-tracker.test.ts`/`grafana.test.ts`，锁定全部 action、route/entry 归一、失败隔离与不改变 feedback/discard。
- JSON 解析、UID 唯一、panel ID 唯一、变量引用和 2 秒 threshold 静态检查。
- 可用时复用本地 Faro→Alloy→Loki 虚构样本验证 LogQL；PromQL 至少做语法/metric-name 静态核对。无 Cloud 写权限时记录限制。
- 运行 Frontend typecheck/test/lint/build、`pnpm lint:complexity`、`git diff --check`。
- 人工场景：Android/iOS 过滤、无数据、N<100、失败/stall、send/regenerate 分开、NDJSON 不混入普通 API、完整流不显示 2 秒 SLO。

## 10. 本地验收提醒

本任务新增跨页面/接口排障入口，建议在 `packages/ui-tests` 后续扩展一个 observability fixture：覆盖 profile 动作、角色 send、creation image action 与失败终态；现有 `@profile`、`@roleplay`、`@image` 可复用。Grafana 查询和真实 Cloud 实收仍不能由 UI mock 替代。
