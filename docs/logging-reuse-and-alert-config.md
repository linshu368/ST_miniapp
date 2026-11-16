# 日志系统复用与告警配置

集中目录、配置契约与迁移清单统一维护在 [日志模块 README](../packages/backend/src/platform/observability/README.md)。

告警只读取 [alert-rules.json](../packages/backend/src/platform/observability/alert-rules.json)，不再读取 LOG_ALERT_RULES 环境变量。技术/业务模块以及精确 HTTP/上游状态筛选均已实现。

无启动副作用的 [SDK 候选入口](../packages/backend/src/platform/observability/sdk.ts) 提供可注入的核心/fetch/job 工厂及通知接口，尚未发布公共包；业务字段和框架接线保留明确的抽取接缝。

应用日志语义、Railway 查询及生产验收边界见 [运行说明](backend-observability-runtime.md)。
