# 实施计划

1. 扩展 shared 社群入口状态契约并更新契约测试。
2. 新增数据库迁移，允许受控的既有成员手动发奖，同时保持自动路径约束。
3. 调整后端 entry 状态映射和 verify-membership 分流，补充可单测的资格选择逻辑。
4. 调整 CommunitySheet：只为 existing_member 展示验证按钮，并更新对应状态文案。
5. 运行 shared/backend/frontend 类型检查及社群相关测试，检查 git diff。

## 回滚点

- 应用代码可独立回滚到旧版本；新状态只有新后端会返回。
- 数据库迁移按 PRD Notes 的策略手工回滚，已发奖励不做破坏性撤销。
