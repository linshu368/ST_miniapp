# 执行

1. shared兼容契约、后端快照与签到拆分DTO、Admin/CLI混合配置。
2. SQL增量检查当前函数形状再替换，保留北京自然日和并发锁；PG既有fixtures扩展验证120/30、2000/1000、老订单、并发重试、回滚、权限。
3. 客户端现有VIP/签到/订单组件按实际拆分展示，复用profile场景验证窄屏和签到成功。
4. 运行相关测试、所有消费者typecheck、lint/complexity与构建；精确两环境迁移账本、远端门禁、dev/main部署验证。
5. CLI先whoami与describe/get，保存原配置，dry-run只两项已授权差异，draft/publish/get。不替换他人草稿；线上效果和版本记录在验收文档。
