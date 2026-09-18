# 技术设计

## 复用调研

已检索 ReplayLifecycleOwner、lifecycle、adapter、flow-telemetry、profile/recharge/order 页面、return-observer、external-payment-pending、open-storage、shared telemetry schema 及相关测试。扩展现有单一 lifecycle 和 adapter，复用 pending TTL、事件契约；无需后端、数据库或新依赖。不建立第二套录制器或通用状态框架。

## 状态和顺序

入口同步保留独立充值 context，SDK 就绪后启动录制，再发送入口事件。后续支付事件待启动尝试完成后发送，避免先于入口事件。付费墙路径继续复用聊天 context。外链打开前同步停录；可信回流后恢复录制，不重置 SDK session ID。新文档仅从有效 pending 恢复支付 context，不伪造聊天字段。根 owner 根据路径和超时结束独立充值。

## 故障模型与最小方案

现有 SDK 加载有 3 秒超时；失败时支付继续。队列有限，不无限缓存。重复点击复用 context，返回按订单去重；pending/order/TTL 必须匹配，单凭 focus 不恢复。外链无效时保持内部录制。存储失败时只保障同文档状态。pay_url 留在短 TTL sessionStorage，沿用输入、URL、network masking。录制仅从充值入口开启且有限时长；无需额外事务、补偿、重试或限流。健康事件沿用 adapter。

## 演进与恢复

兼容旧无 context 的入口事件和现有聊天付费墙；无 shared schema 变更。Preview 先验，Production 保持未配置。回滚前端部署恢复旧行为。验证 `$session_id`、`replay_context_id`、录制网络片段、可播放 Replay，以及第三方页面未被录制。
