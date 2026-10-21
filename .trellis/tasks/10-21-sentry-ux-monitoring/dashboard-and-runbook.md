# 看板与排查手册

Sentry org `wangqiao`（region `https://de.sentry.io`），project `st-miniapp`（前后端共用，靠 `service` 标签区分）。

Sentry MCP 没有创建看板的工具，看板需在 Sentry 界面 Dashboards → Create 里建（先在 Explore → Metrics 里试查询，确认有数据再加进看板）。以下指标代码里都已埋点，**上线后才有数据**。

## 指标清单

| 指标名                                          | 类型             | 来源                          | attributes                                                  |
| ----------------------------------------------- | ---------------- | ----------------------------- | ----------------------------------------------------------- |
| `api.request.duration`                          | distribution(ms) | 前端 `apiClient` / 大厅 fetch | `route` `method` `outcome` `net_type` `tg_platform`         |
| `page.ready.duration`                           | distribution(ms) | 前端，页面可用时刻            | `route` `cold_start` `net_type` `tg_platform`               |
| `page.data_fresh.duration`                      | distribution(ms) | 前端，大厅最新数据到达        | 同上                                                        |
| `page.entry_window.requests` / `.slow_requests` | distribution     | 前端，进页后 10 秒内          | `route` `cold_start`                                        |
| `action.feedback.duration`                      | distribution(ms) | 前端，点击到反馈              | `action` `stalled` `net_type` `tg_platform`                 |
| `asset.load_failed`                             | count            | 前端，chunk/脚本/样式加载失败 | `kind` `net_type` `tg_platform`                             |
| `http.server.duration`                          | distribution(ms) | 后端，每请求                  | `route` `method` `status_class` `kind`(standard/generation) |
| `db.client.operation.duration`                  | distribution(ms) | 后端，每次 Prisma 操作        | `model` `operation` `outcome`(ok/error/pool_timeout)        |
| `runtime.event_loop_delay_p99` / `runtime.rss`  | gauge            | 后端，每 10 秒                | -                                                           |
| `perf.instrument_error`                         | count            | 前后端，埋点自身出错          | `side` `stage`                                              |

`api.request.duration` 的 `outcome`：`ok` / `http_4xx` / `http_5xx` / `timeout` / `network`。

## 覆盖范围

**页面：全部 17 个**都定义了「可用时刻」并开看门狗（4 秒）。页面里 `usePageReady` 传的路由模板必须同时出现在 `page-tracker.ts` 的 `WATCHED_PAGES` 中，否则只记耗时、不会告警。`page-tracker.test.ts` 有一条测试扫描源码强制两者一致，新增页面漏登记会直接测试失败。

**按钮：9 个**会触发请求的关键动作（2.5 秒无反馈告警）——选角色、发消息、充值下单、VIP 下单、每日签到、客服发消息、图片生成提交、语音生成受理、新建创作会话。纯前端交互（切 tab、展开折叠等）不埋点，避免噪声。

长耗时动作（图片/语音生成）的「反馈」取**受理时刻**而非完成时刻：生成本身是几十秒的后台任务，等它完成再判定会把正常流程误报成卡住；真实生成耗时由请求指标覆盖。

**事件**（Issues 里按标签搜）：`perf_event:page_stall`、`perf_event:action_stall`、`perf_event:slow_request`、`perf_event:asset_load_failed`。均为 warning 级，按「类型 + route/action」固定分组，同类问题合并为一个 issue。

> 逐字可照抄的建图清单见 `dashboard-setup.md`。

## 看板建议（每条一张图）

1. **页面可用耗时**：`page.ready.duration` p75/p95/p99，按 `route` 分组。再做一份按 `cold_start` 分组，直接回答"刚进去是不是更慢"。
2. **大厅缓存 vs 最新**：`page.ready.duration`（route=`/`）与 `page.data_fresh.duration`（route=`/`）同图。两条线差距大 = 用户看到的是缓存，后端其实慢。
3. **接口耗时（前端视角）**：`api.request.duration` p95/p99 按 `route`，过滤 `outcome:ok`；另一张按 `outcome` 分组的 count，看 timeout/network/5xx 占比。
4. **接口耗时（后端视角）**：`http.server.duration` p95/p99，`kind:standard`；生成类单独一张 `kind:generation`。前端 p95 明显高于后端 p95 = 慢在网络/Vercel 代理/排队，不在后端处理。
5. **入场窗口**：`page.entry_window.requests` 与 `.slow_requests` 的 avg，按 `cold_start`、`route`。
6. **按钮反馈**：`action.feedback.duration` p95 按 `action`；`stalled:true` 的 count。
7. **稳定性**：`asset.load_failed` count 按 `kind`、`runtime.event_loop_delay_p99`、`db.client.operation.duration` p95 按 `model`，以及 `outcome:pool_timeout` 的 count。
8. **监控自检**：`perf.instrument_error` count，应长期为 0。

## 用户反馈"卡 / 打不开"时怎么查

1. 拿到用户的 Telegram ID。
2. Sentry → Issues，搜 `telegram_user_id:<id> perf_event:*`，看最近的 `page_stall` / `action_stall` / `slow_request`。
3. 打开事件：`page_stall` 的 context 里有当时在途请求列表（路由 + 已等待毫秒数）；`slow_request` 有 `requestId`、耗时、状态。
4. 事件自带 Replay（错误类事件触发回放缓冲），直接看用户当时画面。
5. 点事件里的 trace 看后端耗时。前后端 trace 已串联；若只有前端 span，说明该请求未被采样（trace 0.2）——用 `requestId` 去 Railway 日志搜，后端慢请求（≥3 秒）会写 `slow request` 日志。
6. **查不到事件 ≠ 用户没卡**：事件有每分钟去重，也可能被用户关闭页面打断。去看看板里同一时段、同一 `net_type`/`tg_platform` 的 p95 是否异常。

## 可用性探测（T8，部分完成）

| 监控                                | ID      | 状态         | 说明                                                                                                                                        |
| ----------------------------------- | ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `st-miniapp-frontend.vercel.app`    | 1682869 | active       | 原有。**探的是 Vercel 默认域名，不是用户访问的域名**：域名绑定/DNS 出问题时它照样显示正常                                                   |
| `app.themijing.com`（用户实际入口） | 2485231 | **disabled** | 2026-10-21 新建。启用被 Sentry 挡下：`You don't have enough pay-as-you-go available to create a new seat`，需负责人在 Sentry 加量后手动启用 |
| 后端 `/health`                      | -       | 未建         | Sentry 拒绝：`*.railway.app` 域名在该 Sentry ��域已达 1000 个 uptime 监控上限。需改用自有域名，或走外部探测                                 |

两条待办：

1. Sentry 额度恢复后启用 2485231（监控用户真正访问的域名）。
2. 后端探测换一条不在 `*.railway.app` 下的地址（例如给后端绑自有域名），或用外部探测服务。

定时任务心跳（Railway 支付/对账/VIP 提醒）依赖 Railway 可用，当前 Railway 部署暂停，未开始。

## 上线后要核对的事（T7）

- development 环境先发，确认：事件能带出 Replay；发往后端的请求带上了 `sentry-trace` 头；一条 trace 里同时有前端 `http.client` 与后端 `http.server`；metrics 在 Explore 里能查到；事件里没有 initData/token/聊天正文。
- production 上线后 24 小时：对比 Sentry 配额曲线；对比 LCP/INP p75 与上线前（停止条件：恶化超过 10%）。
- 阈值（慢请求 3s、客户端超时 20s、页面 4s、按钮 2.5s）均为初值，积累一周数据后按 p95 重新定。
