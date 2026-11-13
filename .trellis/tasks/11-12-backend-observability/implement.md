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
