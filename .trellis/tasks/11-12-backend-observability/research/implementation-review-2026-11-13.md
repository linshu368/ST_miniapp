# 日志整改实施前核对

> 后续用户已批准模块顺序与兼容策略，并明确不需要额外日志存储：由 Railway 捕获运行时日志，告警关闭不处理、开启按配置触发。本文件保留审批前证据；持久化/容量上线门禁、跨实例窗口和 outbox 暂停/恢复提案取消，以当前 PRD/design 为准。

日期：2026-11-13。源码基线：`98fd5708`，分支：`feat_log_modules`。核对开始时工作区干净。本文件是待确认方案，不代表产品代码、环境变更或线上验收已经完成。

## 已有授权与待确认边界

用户要求开始本任务、先确认需要选择的事项、整改后按模块逐步 commit。沿用已确认的全量基础链路、低侵入扩展和 `LOG_ALERTING_ENABLED` 默认关闭要求。

本轮需确认：

1. 是否按下表覆盖完整任务，公开状态码与错误码在对应消费者验证后逐批切换；或本次只整改日志，将错误码迁移和告警另做。
2. 是否允许先完成可独立验收的核心及模块整改，将持久化出口、容量和故障窗口作为上线硬门禁；或先完成完整持久化方案再写产品代码。新增资源与费用不在本次代码整改中默认授权。

选择分阶段实施时，仍保留原任务所有未完成验收项。必须在启动前把批准范围、完整模块影响及性能声明写回任务；不能把 pending 改成不适用来绕过门禁。分阶段不等于承诺现有 stdout/内存队列可靠交付，也不等于整体任务完成。

## 源码核对与复用决定

| 范围     | 当前证据                                                                                                                                     | 整改与复用决定                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 请求入口 | `packages/backend/src/app.ts` 的 `genReqId` 接受任意非空入站 ID；全局注册 Sentry 绑定和性能 hook                                             | 保留客户端关联能力，集中限制入站 ID；在根级生命周期接入上下文，覆盖未匹配路由、解析/鉴权早退和断连                     |
| Pino     | `packages/backend/src/lib/logger.ts` 提供根实例、`createLogger`、`requestLogger`、biz/sys；Fastify 请求序列化只输出 method/path/id           | 扩展原入口作为兼容桥，保留现有查询字段；未知路径、错误 message/stack/cause 仍需受控投影，不能认为去掉 query 即完成脱敏 |
| 日志约定 | `packages/shared/src/logging/conventions.ts` 提供字段与顶层/一层敏感键 redact                                                                | 复用约定，增加有界安全投影；不得依靠有限 redact 路径保证任意深度对象与自由文本安全                                     |
| Sentry   | `lib/sentry.ts` 手动 Logs/Issues；`instrumentation.ts` 有 beforeSend/Transaction/Span/Breadcrumb 清洗；后台还有直接 capture                  | 核对 SDK 自动与手动捕获归属，逐批接入统一出口；安全清洗、故障隔离和单次 Issue 要用测试验证                             |
| 指标     | `lib/perf-metrics.ts` 已区分普通请求、SSE 首字和完整流，`engineering-observability.ts` 输出工程指标                                          | 保持计时口径与分母，迁移日志不重置现有指标；不能把完整 SSE 连接耗时当首字                                              |
| 数据访问 | `lib/supabase.ts` 注入 `observedSupabaseFetch`，`lib/db.ts` 使用 Prisma `$allOperations` 扩展                                                | 扩展原客户端边界，不全局替换 fetch；响应头 attempt 与 repository 业务结果分别记录，保持返回值、异常、事务与流生命周期  |
| 后台任务 | `lib/background-observability.ts` 已有作业指标、异常捕获及独立脚本关闭入口                                                                   | 复用生命周期，补独立根上下文和开始/终态；不重新执行任务，不改变退出结果                                                |
| 告警     | `features/alerting/publisher.ts` 已区分 accepted/duplicate/failed；`delivery-worker.ts` 领取后对部分通知做 abandoned 过滤                    | 复用 Publisher/outbox；新来源需要领取阶段隔离/暂停，不能用 abandoned 实现关闭后待恢复；保留原支付过滤行为              |
| 日志交付 | `engineering-observability.ts` 最多 256 条待发；`ops/observability/config.alloy` 为 128 批内存队列、最长 60 秒重试；Docker 使用 `/tmp/alloy` | 现有实现不能作为持久化/重放完成证据。复用 OTLP/Alloy 接线，独立评审持久化与容量，不新建业务数据库日志表                |

依据为本地代码及 `ops/observability/README.md`，未核对远端部署配置、配额、吞吐或真实日志。因此不推断当前生产版本、数据留存和可检索完整率。

## 拟定模块提交与验收

每批按真实依赖保持可独立理解、可回退；表中为拟提交主题，最终文件清单随实际整改确定。不把覆盖清单或设计完成记为实现完成。

| 批次 | 拟提交主题                                                           | 范围及主要验收                                                                                                                     |
| ---- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| M1   | `feat(observability): add safe event core and context`               | 核心事件、上下文、安全投影、输出接口及兼容 Pino；并发隔离、同步/异步返回身份、执行一次、原异常回传、插件失败隔离、脱敏与大小边界   |
| M2   | `feat(observability): unify HTTP terminal logging`                   | 请求生命周期、关联 ID、Pino/Sentry 装配；404/500/解析早退/鉴权/断连、关闭可选出口、唯一 HTTP 终态；原公开协议保持兼容              |
| M3   | `feat(observability): instrument database and upstream boundaries`   | 既有 Supabase/Prisma/第三方入口与覆盖清单；返回 error、超时/取消、连接归还、事务/原始查询、流式响应不提前消费                      |
| M4   | `refactor(observability): migrate generation and media logs`         | 生成/SSE/图片/语音/短剧；首字、完整终态、竞争败方、恢复、交付和结算分别记录，保留失败 attempt                                      |
| M5   | `refactor(observability): migrate payment and background logs`       | 建单/查单/回调/对账/作业；ACK 与入账分离、结果未知、重复回调与单次结算、取消及进程关闭                                             |
| M6   | `refactor(observability): migrate remaining business modules`        | 鉴权、角色/大厅/创作者、钱包/VIP、运营、社区/增长/客服等；按模块再拆 commit，完成入口/方法/脚本清单与旧记录点收口                  |
| M7   | `fix(errors): align error contracts and consumers`                   | 对评审第 13 节每个差异分别落实 shared/producer/consumer；逐模块切换 HTTP/SSE/公开码并保留回退映射，不一次性改所有响应              |
| M8   | `feat(observability): add guarded policy and alert integration`      | 注册规则/模拟动作/默认关闭总控及来源隔离；多实例、重放、窗口、去重/恢复、accepted/delivered、关闭后暂停与既有业务告警不受影响      |
| M9   | `chore(observability): add delivery verification and adoption gates` | 批准后的持久化出口与容量验证、静态门禁、运维/接入文档；独立计数对账、峰值/断网/重启/重放、全量可检索和性能；未验证不得发布或标完成 |

公开错误码登记与兼容映射可在前面批次提前加入；M7 表示公开行为切换与消费者验证的完成批次。持久化方案调研并行于模块整改，若影响事件格式或接线，须在依赖模块实施前回到设计评审。

## 验证及风险收敛

- 优先扩展现有 `sentry.test.ts`、`perf-metrics.test.ts`、`engineering-observability.test.ts`、`preparation-diagnostics.test.ts` 及对应业务/告警测试。新核心涉及敏感信息、并发与错误契约，建议批准必要的核心、HTTP 生命周期和输出隔离回归文件；不为每个日志调用生成镜像测试。
- 每批运行受影响包 typecheck、相关既有测试、适用 lint 和 `pnpm lint:complexity`。修改超长文件时先拆职责并收紧复杂度基线。shared 改动运行 shared tests 及 `pnpm -r typecheck`；跨包/部署修改追加适用 build。
- 人工路径复用 `packages/ui-tests` 的 `@chat`、`@profile`、`@image`、`@drama` 和 creator 流程，建议补充依赖失败、断流恢复与重复订单场景。真实计费、供应商、商户回调和真机仍需目标环境验收。
- 性能维持原提案待确认：按 release/路由/平台比较 P95，Android/iOS 分开，SSE 首字与全流分开；回退不超过 5%，前后各两个完整 24 小时窗口，每组 N<100 延长。当前三类基线无可见样本，保持 null，不宣称达标，也不要求接入暂停中的固定样本本地性能门禁。
- 全量交付上线前必须明确峰值事件/字节量、单条上限、存储配额、故障缓冲时长、恢复吞吐、检索延迟、保留期与成本。应用内存接受、采集端接受、远端持久化、查询命中分开计数。无法满足时停止发布，不牺牲业务事务来伪造零丢失。
- 本轮不修改环境、不操作业务行、不发送告警、不部署。各模块完成后给出改动摘要、验证结果及 commit 记录；不自动 push。

## 本轮状态

完成本地证据核对与提交批次提案，待上述实施边界确认。未执行 `task.py start`，未写产品代码，未运行运行时代码测试，未提交。
