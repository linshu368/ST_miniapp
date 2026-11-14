# 实施设计

用户 2026-11-13 的确认覆盖历史设计中日志存储和复杂告警部分。Railway 捕获 stdout；本次不增加持久化、补传、outbox 或部署资源。

## 复用调研

源码审计见 [implementation-review](research/implementation-review-2026-11-13.md)。复用 lib/logger.ts、Pino、Fastify hooks、Sentry、现有 Supabase fetch/Prisma measureDbOperation、provider 和 job 的结果上报点、FeishuAlertSink。保留 registerRequestPerf 的指标职责。现有支付告警 outbox 有自己的业务语义，不用于运行时日志告警。无需新数据库函数、shared DTO 或通用 DI 框架。

## 最小充分实现

platform/observability 保存类型化事件、Node AsyncLocalStorage.run 上下文、一次终态作用域和安全字段投影。保留 reqId/module/kind，增加 event_id、trace_id/span_id/parent_span_id、request_id、operation、outcome/outcome_known。日志仅接受稳定元数据，错误消息可能含密钥，保留受控类型及源码位置。

HTTP 根 hook 覆盖提前响应与连接中断。显式包装既有客户端，不全局替换 fetch，不消费响应正文，不改变超时/重试/返回身份。SSE、支付 ACK、异步任务分别记录传输和业务事实。

## 可靠性与容量

并发通过 ALS 隔离；终态闭包只完成一次。遥测投影和输出失败隔离，不改变原始返回值/异常。观测不新增业务重试、事务、补偿或写入；保留原幂等机制。支付不根据日志推断提交成功。日志告警直接有限并发发送，有明确超时，无重试和持久化；过载和失败写内部健康日志且不递归告警。进程强杀可能只有 started，不能伪造终态或保障 Railway 的持久化 SLA。

## 演进与恢复

先增加内部事实，再逐模块核对公开错误契约。消费者未验证的状态保持原值。每批独立 commit；可按批回滚。日志开关只控制通知，不控制基础记录或原有支付告警。无迁移、无旧数据改写。异常容量、敏感数据泄漏或性能劣化是停止发布条件。

## 可验证性

用内存 sink、Fastify inject/真实 socket、mock transport 验证并发、脱敏、失败隔离、断开和 SSE。支付运行既有幂等/冲突测试。告警关闭时不解析规则或触发网络，开启时验证规则与失败路径。真实 Railway 查询与移动端 P95 留作发布后人工验证，不用本地模拟代替。

## 2026-11-14 业务关联增量设计（用户授权实施）

复用调研见 `research/business-correlation-2026-11-14.md`。复用 ALS、observer、Pino mixin/白名单、鉴权、用户身份缓存及现有业务校验点；不新增 shared API、数据库函数、查询、前端 hooks 或组件。新增一个内部类型化字段投影文件和一个 HTTP 路由映射文件，避免在各业务复制字段清洗。

链路 context 保持不可变；每个根上下文持有独立的有界关联字段容器，子 span 共享本次业务关联。身份在鉴权/内部用户映射成功后补入，使早已创建的 HTTP operation 在 finish/close 时也能读取。共享用户 inflight Promise 的每个调用者在 await 后绑定自己的上下文，不能只在生产该 Promise 的分支绑定。并行处理不同业务实体时使用克隆关联容器的 `withBusinessContext` 作用域，job 根容器不继承 HTTP 身份。

HTTP 路由模板显式识别 conversations、characters、creator、dramas，参数 ID 只接受 UUID；不遍历请求体猜测任意 id。对象 ID 表示请求目标，不能作为 ownership 证据。POST 短剧播放在校验后绑定剧/集；角色创建在已有返回/校验点补充卡 ID；会话 ownership 通过后补角色 ID。通用 transport 的 module 仍表示 http/db/provider，另以 business_module 表示来源业务。

内部 UUID 的历史 camelCase 名称归一为 snake_case，非法值直接丢弃；telegram_user_id 只从鉴权上下文写入，禁止将任意 legacy userId 数字解释成内部用户。Sentry 复用过滤器时显式去掉本次业务关联字段；告警继续窄投影，指标不接入这些高基数字段。

可靠性：仅增加固定字段内存投影，无新超时/重试/事务/补偿/限流路径；不改变原业务幂等与错误。字段数量和长度固定，输出仍走既有失败隔离。不存在的 ID 留空，不为补日志查库。风险是并发串号、实体语义混淆和出口泄漏，须用真实 JSON 与并发测试锁定。兼容为日志增量字段，无迁移/旧数据回填；应用部署后才生效，回滚应用即可恢复。停止条件沿用敏感字段/容量/P95 劣化；Android/iOS/API 继续按原任务窗口核验，无样本保持 null。
