# 执行计划

1. 实现有界的专用 PostgreSQL advisory-lease helper，并让支付告警 Worker 通过它运行单轮。
2. 添加最小回归测试，锁定同 client 解锁和异常/竞争清理行为。
3. 运行 Backend 测试、typecheck 与 `git diff --check`；不执行迁移、写生产数据库或发送测试飞书消息。
4. 获得单独发布授权后，提交/合并并验证生产实例 SHA、连续心跳、连接池错误消失和实际 outbox 投递。
