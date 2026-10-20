# 恢复图片广场配置白名单

## 需求与范围

用户报告 TEST 模型管理保存草稿触发 config_drafts_config_key_check，并明确要求新增兼容迁移恢复。已确认方案：恢复图片广场四个 key 的管理白名单与 drafts/releases 约束，保留当前合法 key；不改历史 SQL、校验规则、业务数据、正式配置或应用代码，不执行远端迁移。

## 验收标准

- 新迁移仅扩展允许范围，保留旧函数行为、CHECK 表达式与验证状态。
- 四个 key 可通过两张表的 CHECK；合法图片配置通过现有 validator，非法配置仍拒绝。
- 前置缺失、重复执行、锁超时或自检失败时事务整体回滚。
- 无配置自动发布，无新增公开 RPC 权限；附 TEST 发布与 forward-fix 说明。
- 运行 migration lint、shared/admin 既有测试、全仓 typecheck 和适用 build；不能执行的 PostgreSQL/TEST 验收明确记录。
