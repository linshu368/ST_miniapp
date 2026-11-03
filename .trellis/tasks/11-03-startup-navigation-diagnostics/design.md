# 设计（已获用户批准）

复用调研：已检索 startup-phases.ts、startup-timing.ts、sanitize.ts、page-tracker.test.ts、sanitize.test.ts 与启动性能文档。复用 collectStartupDetails、STARTUP_DETAIL_FIELDS 以及 sanitizeStartupDiagnostic；现有 stages 循环只发旧指标，新增字段仅进 details。组件/hooks/API/repository/数据库函数不涉及。

可靠性：Navigation Timing 缺失/异常降级，单条原始值非有限、负数或晚于观测时间则省略；反序段省略，secureConnectionStart=0只保留原值不计算TLS；无IO所以超时、重试、事务、幂等、补偿、限流不适用。并发/每文档去重复用现有 observer；容量为固定字段，新增序列化上下文预算2KB。

最小方案：只改一个产品文件，不增加模块、依赖、状态源、公开API、定时器或网络请求；不扩展 STARTUP_STAGE_NAMES。原始时间点+七段及TLS子段，数值版本 navigation_diagnostics_version=1。TLS不是额外可加阶段，请求到首字节不是纯服务端CPU。

演进恢复：旧事件没有新字段，旧 startup_phases_v2 和主指标不变；功能分支提交推送，部署另行处理。异常或开销超预算停止后续发布，回退对应前端提交，无迁移/配置回滚。
