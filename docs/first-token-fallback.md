# 首 token 兜底与人工观察

本期为自研会话的发送、重新生成增加可配置的单一兜底及体验数据。应用与两份基础迁移已完成生产发布；Grafana按下述只读迁移与独立看板接入。没有 AI 判断、定时调参、惩罚公式或自动改配置。

## 运行规则

| 配置             | 初始值                                         | 管理位置                                        |
| ---------------- | ---------------------------------------------- | ----------------------------------------------- |
| 兜底型号         | OpenRouter `deepseek/deepseek-v4.1-flash-1017` | 运营配置 → 兜底配置，可搜索选择 OpenRouter 型号 |
| 每型号首发等待   | 4000ms                                         | 同页，各首发型号分别编辑                        |
| 全局首 token SLA | 6000ms                                         | 同页，人工固定                                  |
| 超时率目标       | 0.01，即 1%                                    | 同页，人工监控                                  |

本页复用模型目录的同一份草稿、发布历史与回滚；模型目录的型号增删会同步出现在此表中。选择兜底型号、修改各等待参数后，保存草稿并明确发布才会生效。若模型目录也有未发布改动，会随同一份草稿一起发布。每轮受理时冻结型号及参数，发布不会改变进行中的请求。

兜底请求沿用本轮受理时冻结的深度思考开关，OpenRouter 与 Venice 分别通过对应参数传递；强制思考型号仍按供应商实际输出处理。已执行的历史迁移保留旧 SQL 缺省值及校验和；新后端显式传递受理时冻结的型号。缺字段的目录使用上述 1017 默认值，已有显式值则以运营发布值为准。

旧目录缺少字段时也使用上述默认值；新增型号默认 4000ms。等待必须为正整数毫秒且小于全局上限。正常的草稿、发布、恢复链路保留这些值。当前不会随数据自动调整。

普通模式从首发实际派发后开始计该型号等待；超过等待仍未出现非空内容 token 才启动一次兜底。开启深度思考时，供应商可能先静默推理，因此不按 4 秒等待切换型号；第一个非空思考文字与第一个正文文字仍同等作为真实首字。关闭时只认正文。仅 role、空白、HTTP headers 不算可显示 token。普通模式启动兜底后不再切回首发；首发迟到的内容只供观察，绝不混入回复。首发本身就是所配兜底型号时不再重复调用。上游提前报错沿用已有错误流程，本期不另加错误重试。

全局首字 SLA 包含前置准备、首发等待、兜底准备、兜底首 token、传输和页面显示，不因切换重置。后端从路由入口计时，前端从提交动作以同一个 `performance.now()` 计到实际正文 DOM 或已开启思考的 DOM 有可见文字并获得绘制机会。普通与深度思考模式达到 6 秒仍无首字时，都只记录服务端/客户端 SLA 超时事实，不显示失败、不自动取消或中断上游。普通模式的 4 秒单次 fallback 不变。两种模式仍受服务端 110/120 秒和客户端 150 秒绝对生命周期、显式取消及残留恢复限制；服务端只读准备另有独立 20 秒有限预算。

客户端观测方法为 `visible_dom_after_frame_v1`：正文或开启思考的节点、可见非空白文字、视口/滚动裁剪、两次 animation frame。它是浏览器能提供的显示近似，不是物理屏幕像素确认。隐藏页不记“已显示”，记录是否进入后台。浏览器冻结时无法保证客户端代码恰在第 6 秒运行，后端预算仍独立生效。

## 原价、权益与观察

一轮只有一个 chat history revision、一个 charge ID、一次免费额度预留及同一结算链。原型号报价、VIP、钱包政策和免费权益冻结；交付兜底只改变实际 provider/model 路由。账单展示仍为用户所选型号。旧 OpenRouter/Venice 明细表只绑定实际交付的尝试，观察首发不参与扣费同步。

普通模式切换后的首发可以继续观察到它真正的首个内容 token，随后立即停止；不生成完整观察回复。观察最多到原请求 110 秒保护边界。6 秒 SLA 超时不停止首发或 fallback；用户明确取消和绝对生命周期仍会终止在途尝试。进程消失或没有拿到真实 token 时记录删失/未知，不能把等待阈值当成其实际首 token 耗时。

服务端可能已完成回复，而浏览器因后台、主线程或网络尚未显示。此时保留“客户端超时”和已经发生的服务端终态，取消不会改写已完成的回复；本期没有基于客户端回报退款。客户端时间是体验分析依据，不能作为可伪造的扣费授权信号。

## 数据口径

`experience.chat_generation_requests` 一行一轮 revision，记录所选型号/路由、目录版本、当轮兜底型号及阈值/上限/目标快照、兜底触发、最终交付身份、服务端首 token 写出时长和客户端结果。开轮后、读取 prompt 之前就建行，准备阶段失败也保留；余额/VIP 拒绝标记 `billing_rejected` 并从有效生成报表分母排除。开轮前鉴权、归属、配置失败及离线请求无法归属到这个 per-model 表，不应把此报表冒称为全部客户端点击覆盖。

`experience.chat_generation_attempts` 每轮最多首发、兜底两条，记录准备身份、实际派发时间/相对入口偏移、headers、首 chunk、首内容 token、观察截止、HTTP 状态、结束原因、generation ID 和供应商 metadata。明细不包含 prompt、回复正文、key 或 Telegram initData。

所有业务耗时和 OpenRouter latency 统一以毫秒存储，但含义不替换：

- **用户总首 token**：提交 → 文字 DOM 可见并获得绘制机会。只取客户端真实报告；缺报、未显示均为 NULL。
- **首发等待**：真实首发派发 → 触发兜底；未切换则为真实首 token。
- **兜底准备延迟**：触发兜底 → 兜底真正派发，包含持久化和路由准备。
- **尝试首 token**：各自网络派发 → 后端实际观察到内容 token，在等待 generation ID 入库之前测量。
- **服务端写出**：后端路由入口 → 首个内容 delta 交给 SSE sink，不代表客户端已显示。
- **client/server residual**：用户总耗时减服务端写出时长，包含客户端提交前段、进出网络和显示等；不能全部归因于网络。
- **provider latency**：OpenRouter `/generation` 上游自报毫秒，可能按 reasoning-first 定义，scope 单独保留。缺失不补零，不用业务时间冒充供应商值。Venice 当前业务测得的 latency 不冒充其供应商自报。

供应商单位依据官方 [SDK v0.9.11 的字段定义](https://github.com/OpenRouterTeam/typescript-sdk/blob/v0.9.11/src/models/operations/getgeneration.ts)；[官方 metrics 说明](https://openrouter.ai/blog/announcements/better-insights-faster-metrics-and-new-developer-power-tools/) 提醒 reasoning 模型的首 token 语义。两者差异是排查线索，需要结合定义与 headers/派发/显示分段判断。

客户端 `observed / timed_out / not_observed / missing` 独立保留，重复回报只接受第一次；回报需匹配 user、session、history、request ID、revision。revision 从 0 开始，不做 telemetry 的 0→1 投影。后台样本保留并单列，不能混进前台等待分位数。分位数只描述有真实可见耗时的成功样本，必须同时看超时/缺报，避免幸存者偏差。

## 每 24 小时的人工报告

使用明确时区及左闭右开的窗口。例如北京时间 2026-10-22：

```sql
SELECT * FROM miniapp_analytics.chat_first_token_report(
  '2026-10-22 00:00:00+08'::timestamptz,
  '2026-10-23 00:00:00+08'::timestamptz
);
```

按所选型号总体请求数判断 `sample_eligible >= 150`；两次 attempt 仍算一次请求。报表继续按等待参数、兜底型号、全局上限、目标、目录版本和上游映射分组，并返回该组实际样本数；一个只有 1 条样本的参数组不会因型号总体够 150 就变成可靠的实验结论。低于 150 沿用初始值，不参与未来智能调整。

重点一起看：用户总首 token p50/p90/p95、兜底启动/被选/确实显示比例、前台已知结果超时率、回报覆盖率、缺报/未观测/后台/失败数量，以及首发/兜底分段和供应商差值。`foreground_timeout_rate_observed` 的分母只含前台 observed/timed_out；`client_timeout_rate_lower_bound_all` 只是全体请求上的已知超时下界。缺报较多时不能据下界宣称达成 1%。

原始 JSON 导出供人工进一步计算，不包含对话内容：

```sql
SELECT to_jsonb(f) FROM miniapp_analytics.chat_first_token_facts f
WHERE request_received_at >= '2026-10-22 00:00:00+08'::timestamptz
  AND request_received_at < '2026-10-23 00:00:00+08'::timestamptz
  AND requested_model_id = '你的型号 stable ID'
ORDER BY request_received_at, chat_history_id;
```

未来只比较同一型号的不同等待参数/时间窗口。用户补充的损失函数背景是：3 秒内无等待惩罚、超额等待分段惩罚；兜底率 20% 以内不惩罚；最终失败/超时率 1% 以内不惩罚。系数与公式未决定，本期不写死，不跨型号排名，也没有自动取数、自动判断或自动发布。

## 数据库、Grafana 与上线顺序

1. 先审查、手动应用 `packages/shared/migrations/20261023_chat_first_token_fallback.sql` 到 TEST，按照仓库 migration ledger 流程记录。它添加事实表/RPC、analytics view/report 及模型配置校验；不删历史列、不回填业务数据。随后单独应用 `20261023_chat_first_token_fallback_config.sql`，使 begin/prepare RPC 与分析报表支持受理时冻结的可配置兜底型号；保持既有函数签名、权限与数据。
2. 新增表及 RPC 默认只允许 service_role，经后端 API 写入；客户端角色没有直写权限。Grafana 用单独只读角色；通过正式 workflow 先TEST后production执行 `20261023_grafana_first_token_reader.sql`。它为既有 `grafana_cloud` 角色授予可继承的 NOLOGIN reader 会员关系，拒绝异常角色属性或既有正文权限。仅能读事实、报表和父表id/status/llm_finish_reason，不能读对话正文或写报告。旧手工脚本仅保留参考，线上使用版本化迁移；不能用 service_role key 给 Grafana。
3. 通过 TEST Backend 验证新 RPC 可被 PostgREST 正确发现，发布后端；再发布前端、Admin。两份迁移与新后端部署完成前，不发布非默认兜底型号。旧前端不会上报显示数据，会如实记 missing；新前端需要新接口。数据库迁移必须先于新后端。
4. 导入 `docs/grafana/chat-first-token.json`，选择 TEST PostgreSQL datasource，选择一个型号，核对窗界、单位、150 门槛和覆盖率。没有改线上现有 dashboard。
5. TEST 验收真实 OpenRouter/Venice、Telegram WebView、网络慢/后台/取消和一次扣费，再单独批准生产迁移、配置发布和应用上线。本地 mock 不证明固定 fallback 型号在真实账号上的可用性。

回滚应用时保留新增表和事实；旧后端不会使用它们。回滚前先等待活跃生成结束，避免中断预留/交付事务；不要删除历史观察数据。回滚配置前仍须满足型号等待小于全局上限。

本地回归：`bash scripts/test-first-token-fallback-local.sh` 使用一次性 PG17 容器、实际新迁移和既有钱包/VIP/额度 SQL，并自动清理；不读取应用 env，不连远端，也不调用付费模型。

## 直接查看业务看板

新增看板“05｜用户首 token 与兜底体验”，绑定现有生产PostgreSQL数据源 `ST TelegramBot Supabase`（uid `fg1oltvmm56v4b`），不改其密码或旧看板。默认北京时间过去24小时，5分钟刷新，可选全部或部分型号。总览只列该时间内有有效请求的型号。

- 用户总首token=P50/P90/P95的客户端实际显示时间，单位秒，包含首发等待与兜底全过程；只取前台observed样本，不筛整条回复成功，也不用后端/供应商数值补齐。
- 兜底触发率=触发兜底请求/全部有效请求，触发后失败也计入；已看到样本中兜底占比另列，分母为前台已看到样本。
- 前台已知结果超时率=前台timed_out/(前台observed+timed_out)。缺报、后台和其他未观测不算成功，同时显示回报覆盖率、可判定占比和样本数；没有该项样本显示“—”，不补0。
- 下方人工对照保留同型号各配置版本/等待参数组；不平均各组百分比或P90，不进行自动调整。

应用迁移后，以真实Grafana数据源执行所有面板并检查浏览器显示。撤销新读取权限可执行受审核的 `REVOKE first_token_metrics_reader FROM grafana_cloud`；保留事实数据和旧看板。
