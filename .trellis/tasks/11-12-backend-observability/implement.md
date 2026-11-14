# 执行计划

## 合并适配与日志完整性审计

1. 检查五个冲突的 base/ours/theirs，合并上游文案及新增 shared export，保留日志分支错误契约和拆分结果；复杂度基线只保留实际仍存在的超标项。
2. 运行日志 AST 门禁，核对上游新增/变更的 HTTP、SDK、后台和业务日志；补 transport、被投影丢弃的必要标量、业务模块与正确对象 ID；复用既有 schema/授权点，无新业务查询。
   补查 createClient/new PrismaClient/pg 的实际接缝：复用共享 Prisma 扩展到 dedicated client，pg lease 包装原 connect/query/end；拆小已超标排序方法并回归锁/清理顺序，无新增 SQL 或重试。
3. 按审计结果扩展现有 welcome/growth/http/logger/core 等回归文件，核对 Telegram payload 失败、HTTP 非成功、并发上下文、投影/通知安全；合并消费者覆盖 shared 与 SSE 流错误兼容。
   会话字段绑定位置错误涉及身份归属，允许新建一个纯 mock repository 回归文件，直接调用真实 getSession/requireSession 验证 ownership 条件和字段，防止 route mock 掩盖再次错绑。
4. 补齐新增任务 logging_integration、后端/前端/shared 入口与 implement/check 规范的接入检查；同步运行说明、验收记录和模块知识载荷。
5. 运行 shared tests、全仓 typecheck、backend 全量无凭证测试（2 workers/15 秒）、Frontend 流式测试、Frontend/Admin build、变更文件 lint/format、日志/复杂度/规划门禁与 diff 检查。记录合并索引状态和未覆盖线上实测；最终人工审核后方可暂存/提交。

## 2026-11-14 业务关联字段补充

1. 扩展现有 context、EventFields/Pino 安全投影；业务字段与固定 trace/span 不互相覆盖，保留 legacy 字段别名输入，输出统一 snake_case。新增内部 helper 只服务已有消费者。
2. HTTP 模板绑定业务模块与 UUID 目标；鉴权成功绑定 Telegram 身份，内部身份解析（含缓存命中/共享 inflight）绑定内部 user_id。创建角色、已验证会话与 POST 短剧播放补充对象字段，不加 DB 查询。
3. 检查 started/terminal、连接断开、子 transport、并行业务作用域及独立 job；Sentry/告警出口继续不传新增业务身份。同步运行说明、README/架构和相关规范。
4. 扩展已有 core/http/logger/user/auth 及相关业务测试，必要时在这些文件中增加测试，不创建平行框架。验证非法 ID/伪造用户/未知字段被丢弃，两个用户并发不串号，缓存等待者均绑定，404/500/SSE 终态保持结果；运行 backend typecheck、全量无凭证测试、受影响文件 ESLint、日志 guard、复杂度和 diff 检查。公开契约不变，consumer 以既有 route 测试和后端类型检查验证。
5. 人工发布后在 Railway 从已知用户/卡/剧/会话找到 trace，再核对 HTTP→DB/provider→业务终态；分别验证成功、拒绝、供应商失败、SSE 断开。复用本地 @chat/@creator/@drama 流程辅助造请求，不新增 UI 或一次性脚本；真机/真实供应商/P95 不由模拟替代。

本次规划由当前代码调研与用户明确范围确认后执行，原任务保持 in_progress；补充的验收结果单独记录，旧验证结果不充当本次证明。

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
