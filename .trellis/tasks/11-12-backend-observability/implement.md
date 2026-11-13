# 执行计划

1. 核心事件、字段投影、安全错误、并发上下文、一次终态；验证输出失败不影响业务。
2. HTTP/Pino：关联 ID、404/500/提前响应、超时/中断/SSE；Sentry 出口安全独立核验。
3. DB/第三方：保留返回身份、AbortSignal、超时与重试；验证异常、非成功状态和未读正文。
4. 生成/媒体：区分 attempt、最终生成、流交付；断线与迟到成功不得覆盖终态。
5. 支付/后台：区分回调 ACK、结算、查询和恢复；任务独立上下文、跳过/部分失败真实上报。
6. 错误码：按评审第 13 节整理 producer/consumer 矩阵；shared 先定义增量契约，再验证客户端。
7. 日志告警：默认关闭，配置匹配、安全通知、有限并发/超时/无递归；不使用持久化。
8. CI 静态约束、README/架构/spec/验收记录及模块提交。

每批：backend typecheck、相关既有测试、ESLint、pnpm lint:complexity、git diff --check。跨包：shared tests、pnpm -r typecheck、适用 build。测试并发限制为 2，避免本机资源争用造成导入超时。不 amend、不 push。

发布验收：复用 ui-tests 的 @chat/@profile/@image 场景检查余额不足、会话失败、取消、支付恢复；供应商真实计费、Railway 日志查询与 Android/iOS/API/SSE P95 仍需实际环境数据。

## 2026-11-13 审计补充（用户已授权实施）

按模块修复并提交：1）子 logger 绑定白名单；2）无 event 错误兜底与告警字段映射；3）安全错误分类和畅聊计数；4）HTTP 各完成路径统一等级；5）畅聊 transport/job 上下文及静态门禁。

复用现有 Pino hooks、safeError/safeLogRecord、告警通道、clientFetch/runObservedJob。内部错误码与公开错误码保持独立，既有 error_codes 规则兼容匹配两者；不改公开 API、业务重试、支付/生成行为或数据库。告警仍默认关闭，不增加存储、限频配置、窗口聚合或部署资源。各模块可独立回滚；上线后继续沿用原任务的真实 P95 验证要求。

回归必要性：此次涉及敏感数据出口、告警漏报和并发关联，补充已有 logger/log-alerts/http/core/free-zone 测试；静态检查如需独立用例可新建 Node test 文件。覆盖嵌套子 logger、Error/普通错误对象、关闭时零通知、HTTP/SSE 公开码、旧字段别名、重复终态、行情超时和 job 并发上下文，验证正常返回/失败行为不变。每批 backend typecheck、相关测试、ESLint、复杂度；最后全量无凭证 backend 测试与日志门禁。新增日志文件或规则不成为业务状态源。

## 后续功能规划日志门禁（用户已要求实施）

复用 task.py start 的现有校验位置、task_store 的任务模板和 Quality Gate。增加 meta.logging_integration（pending/required/not_applicable），新任务默认为 pending；任何任务 start 前必须完成，旧任务重新启动时补声明。required 覆盖影响范围、复用接入点、事件/等级/结果/字段、链路、脱敏、失败路径、告警和验证。纯文档/静态样式不适用需要具体理由；功能改动优先声明复用现有日志，不能以“已有统一日志”为理由跳过评估。

CI 按 base..HEAD 校验新增/修改的活跃任务规划（task.json/prd/design/implement/task），不追溯未改动或存档的历史任务；本地 start 没有缺字段兼容豁免。缺失、pending、占位或结构不全时失败，发生在状态/活动指针写入前。规则说明集中于项目 spec，AGENTS、workflow 与生成 PRD 引用；不修改全局 Trellis 或 bundled skill。

风险与验证：无业务数据/服务/移动端性能变化，仅本地规划与 CI；校验失败不得产生状态副作用。允许新建 Python unittest 文件，覆盖创建默认值、校验矩阵、正常/无会话 start 阻断、旧任务重启、CI 变更选择和未改动历史兼容。按工具代码和规范两批提交，可回滚新增校验调用；日志运行时门禁保持不变。
